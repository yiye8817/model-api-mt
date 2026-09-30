'use strict';
// Local-only recovery. Never replays HTTP bodies, refills prompts or reloads.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');

function privateDirectory(folder) {
  const absolute = path.resolve(folder);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_retry_directory');
  }
  return absolute;
}
function privateWrite(file, data, append = false) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : fs.constants.O_EXCL) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}
const safeDescriptor = value => value && typeof value === 'object' && /^[a-z][a-z0-9-]{0,30}$/.test(value.tag || '') &&
  ['id','testid','aria','title','role','label'].every(k => value[k] === undefined || typeof value[k] === 'string' && value[k].length <= 160) &&
  Array.isArray(value.classes) && value.classes.length <= 5 && value.classes.every(c => /^[a-zA-Z_][\w-]{0,60}$/.test(c));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function imageFeature(image, bounds = null) {
  const size = image.getSize();
  let cropped = image;
  if (bounds) {
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y), w = Math.ceil(bounds.width), h = Math.ceil(bounds.height);
    if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || w < 4 || h < 4 || x + w > size.width || y + h > size.height) return null;
    cropped = image.crop({ x, y, width: w, height: h });
  }
  const pixels = cropped.resize({ width: 24, height: 24, quality: 'good' }).toBitmap({ scaleFactor: 1 });
  if (pixels.length !== 24 * 24 * 4) return null;
  const gray = [];
  for (let i = 0; i < pixels.length; i += 4) gray.push((pixels[i] + pixels[i+1] + pixels[i+2]) / 3);
  const min = Math.min(...gray), max = Math.max(...gray);
  if (max - min < 24) return null; // blank/hidden/transparent screenshot is not evidence
  return { version: 1, values: gray.map(v => Math.round((v-min)*255/(max-min))), contrast: max-min };
}
function featureSimilarity(a, b) {
  if (!a || !b || a.version !== 1 || b.version !== 1 || a.values?.length !== 576 || b.values?.length !== 576) return 0;
  if (![...a.values,...b.values].every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return 0;
  let normal = 0, inverted = 0;
  for (let i = 0; i < 576; i++) { normal += Math.abs(a.values[i]-b.values[i]); inverted += Math.abs(a.values[i]+b.values[i]-255); }
  return 1 - Math.min(normal,inverted)/(576*255);
}
function selectVisualTarget(image, report, learned) {
  const rows = (report.candidates || []).slice(0,32).map(c => {
    const feature = imageFeature(image, c.bounds);
    const similarity = featureSimilarity(feature, learned?.feature);
    return { ...c, feature, similarity };
  }).filter(c => c.feature);
  const matched = rows.filter(c => c.semantic || learned && c.learned && (!learned.feature || c.similarity >= .93) || learned?.feature && c.similarity >= .97);
  // No general "click the only icon" guess. Without semantic evidence or a
  // successful learned template, manual handling is safer than another action.
  if (matched.length !== 1) return { target: null, reason: matched.length ? 'visual_ambiguous' : 'visual_no_verified_match',
    candidates: rows.map(({feature,...row}) => row) };
  return { target: matched[0], reason: matched[0].semantic ? 'screenshot_semantic_target' : 'screenshot_learned_template',
    candidates: rows.map(({feature,...row}) => row) };
}

class RetryArtifacts {
  constructor(options, job, emit) {
    this.emit = emit; this.folder = null;
    this.context = { provider: 'qwen', job_id: String(job.job_id || '').slice(0,160),
      request_id: job.request_id || null, http_id: job.http_id || null };
    this.content = !['0','false','off'].includes(String(process.env.FUSION_LOG_CONTENT || '').toLowerCase());
    this.learning = job.qwen_retry_learning !== false;
    this.origin = new URL(options.origin).origin;
    this.learnFile = path.join(options.learningDirectory || process.env.FUSION_RETRY_LEARNING_DIR ||
      path.join(process.env.FUSION_DATA_DIR || path.join(os.homedir(), '.local/share/multillm-fusion'), 'retry-learning'), 'qwen.json');
    try {
      const root = privateDirectory(options.directory || process.env.FUSION_RETRY_DIR || path.join(process.env.FUSION_LOG_DIR || path.join(__dirname,'..','logs'), 'retry', 'qwen'));
      const id = crypto.createHash('sha256').update(String(job.job_id)).digest('hex').slice(0,12);
      this.folder = path.join(root, `${new Date().toISOString().replace(/[:.]/g,'-')}-${id}-${crypto.randomBytes(3).toString('hex')}`);
      privateDirectory(this.folder);
      this.event('adapter.retry_artifacts', { directory: this.folder, content_retained: this.content, learning: this.learning });
    } catch (e) { emit('adapter.retry_artifact_failed', { operation: 'initialize', code: e.code || e.message }); }
  }
  event(event, fields = {}) {
    fields = { ...this.context, ...fields };
    this.emit(event, fields);
    if (this.folder) {
      try { privateWrite(path.join(this.folder,'attempts.jsonl'), JSON.stringify({ time: new Date().toISOString(), event, ...fields })+'\n', true); }
      catch(e) { this.emit('adapter.retry_artifact_failed', { operation: 'append', code: e.code || e.message }); }
    }
  }
  saveImage(name, image) {
    if (!this.content || !this.folder) return null;
    try {
      const file = path.join(this.folder, `${name}.png`), png = image.toPNG();
      if (png.length > 16*1024*1024) throw new Error('screenshot_size_limit');
      privateWrite(file,png);
      this.event('adapter.retry_screenshot_saved', { file, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') });
      return file;
    } catch(e) { this.event('adapter.retry_artifact_failed', { operation:'screenshot', code: e.code || e.message }); return null; }
  }
  load() {
    if (!this.learning) return null;
    try {
      const st = fs.lstatSync(this.learnFile);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 65536 || st.mode & 0o022) throw new Error('unsafe_learning_file');
      const fd = fs.openSync(this.learnFile,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let row; try { row = JSON.parse(fs.readFileSync(fd,'utf8')); } finally {fs.closeSync(fd);}
      if (row.version !== 1 || row.origin !== this.origin || row.provider !== 'qwen' || row.confirmed !== true || !safeDescriptor(row.descriptor)) throw new Error('invalid_learning_record');
      if (row.feature && featureSimilarity(row.feature,row.feature) !== 1) throw new Error('invalid_learning_feature');
      this.event('adapter.retry_learning_loaded', { file: this.learnFile, confirmed: true }); return row;
    } catch(e) { if(e.code !== 'ENOENT') this.event('adapter.retry_learning_unavailable',{code:e.code || e.message}); return null; }
  }
  promote(click, image) {
    if (!this.learning || !click?.trusted || click.origin !== this.origin || !safeDescriptor(click.descriptor)) return false;
    let temporary;
    try {
      privateDirectory(path.dirname(this.learnFile));
      let feature = null;
      if (image) {const size=image.getSize();if(size.width===click.viewport.width && size.height===click.viewport.height) feature=imageFeature(image,click.bounds);}
      const row = { version:1, provider:'qwen', origin:this.origin, confirmed:true, confirmed_at:new Date().toISOString(),
        evidence:'trusted_click_then_new_generation_and_complete_answer',descriptor:click.descriptor, feature };
      temporary = `${this.learnFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      privateWrite(temporary,JSON.stringify(row,null,2)+'\n');
      fs.renameSync(temporary,this.learnFile);
      this.event('adapter.retry_learning_saved',{file:this.learnFile,descriptor:click.descriptor,template_saved:Boolean(feature),confirmed:true});
      return true;
    } catch(e) { this.event('adapter.retry_learning_failed',{code:e.code || e.message}); return false; }
    finally { if(temporary)try{fs.unlinkSync(temporary);}catch{} }
  }
}

async function runQwenRecovery(ctx) {
  const { job, act, observe, network, wc, deadline, pause, status, acquire, release, dispatch, pollComplete, resume, fail } = ctx;
  const artifacts = ctx.artifactStore || new RetryArtifacts({ ...ctx.artifacts, origin:ctx.origin },job,ctx.log);
  const log = (e,f) => artifacts.event(e,f);
  const learned = artifacts.load();
  const triggerWait = clamp(Number(job.qwen_retry_trigger_wait_seconds ?? 3), .5, 15)*1000;
  const manualWait = clamp(Number(job.qwen_manual_retry_wait_seconds ?? 20), 1, 120)*1000;
  const mark = () => network.checkpoint?.() || {responseCount:0,failureCount:0};
  let imageBeforeManual = null, manualImageCandidates = [], learnedClick = null, seenClicks = 0, attemptNo = 0;
  let guardCheckpoint = ctx.entryCheckpoint || mark();
  let lastSnapshot = ctx.entrySnapshot || await observe(true);
  const sleep = () => pause(Math.min(200,Math.max(1,deadline-Date.now())),deadline,ctx.signal);
  const idleError = s => s.recovery?.contextValid && s.recovery.currentTurnAccepted && s.recovery.currentError && (!s.stopping || s.recovery.staleStopIgnored) && !s.responsePending;
  const capture = async (name,viewport) => {
    if (typeof wc.capturePage !== 'function') {log('adapter.retry_screenshot_unavailable',{reason:'capturePage_unavailable'});return null;}
    try {
      const img = await ctx.bounded(wc.capturePage(),deadline,ctx.signal);
      if (img.isEmpty?.()) throw new Error('empty_screenshot');
      const size = img.getSize();
      if (size.width <= 0 || size.height <= 0 || size.width*size.height > 32*1024*1024) throw new Error('invalid_screenshot_size');
      const output = viewport ? img.resize({ width:Math.round(viewport.width),height:Math.round(viewport.height),quality:'good' }) : img;
      artifacts.saveImage(name,output);
      return output;
    } catch(e) {if(ctx.signal?.aborted)throw e;log('adapter.retry_screenshot_failed',{reason:e.code||e.message});return null;}
  };
  async function waitResult(checkpoint, baseline, stage, waitUntil, manual = false) {
    let started = false, monitorClicks = manual, lastCountdown = -1;
    while (Date.now() < deadline) {
      const snapshot = await observe(true);lastSnapshot = snapshot;
      const current = mark();
      if(manual && !started) {
        const seconds = Math.max(0,Math.ceil((waitUntil-Date.now())/1000));
        if(seconds !== lastCountdown){lastCountdown=seconds;log('adapter.retry_manual_wait',{remaining_seconds:seconds});
          status('manual_retry_required',`请打开 Qwen 原会话点击重试，剩余 ${seconds} 秒；检测到新请求后继续采集，成功后保存点击控件。`);}
      }
      if(monitorClicks){
        const clicks = (await act('recoveryWatchPoll')).clicks || [];
        for(const click of clicks.slice(seenClicks)){log('adapter.retry_manual_click',{click});}
        seenClicks = clicks.length;
        if(current.responseCount>checkpoint.responseCount){
          learnedClick = [...clicks].reverse().find(c=>c.trusted && c.at <= Date.now() && Date.now()-c.at <= 5000) || null;
          monitorClicks = false;
        }
      }
      const newRequest = current.responseCount > checkpoint.responseCount;
      // With no visible endpoint, accept an actual generation-state transition
      // only when the previous error has cleared; a changed error fragment is not proof.
      const stateStarted = !network.state?.().observed && snapshot.stopping && !baseline?.stopping && !snapshot.recovery?.currentError;
      const originalContinues = ctx.cause.code === 'timeout' && !baseline?.recovery?.currentError &&
        (baseline?.responsePending || baseline?.stopping) && !network.state?.().failed?.length;
      if(!started && (newRequest || stateStarted || originalContinues)) {
        started = true; network.acknowledgeFailures?.(checkpoint); resume(baseline,snapshot);
        log('adapter.recovery_observed',{stage,evidence:newRequest?'new_generation_request':originalContinues?'original_generation_still_running':'generation_indicator'});
        log('adapter.retry_stage_result',{stage,result:'new_generation_observed',response_count:current.responseCount});
        status('recovering','已观察到 Qwen 的新生成请求，继续等待完整回答…');
      }
      if (current.failureCount > checkpoint.failureCount) {
        log('adapter.retry_stage_result',{stage,result:'generation_failed',responses:network.state?.().failed || []});
        return {state:'failed'};
      }
      if(started && !snapshot.recovery?.currentError && !network.state?.().failed?.length){
        // Completion extraction may need one bounded native click to read a
        // provider's Markdown clipboard export. Support both the historical
        // synchronous callback and the async Qwen JSON fallback.
        const result = await pollComplete(snapshot);
        if(result.done){
          const sameFrameTarget=learnedClick && manualImageCandidates.some(c=>
            JSON.stringify(c.descriptor)===JSON.stringify(learnedClick.descriptor) &&
            ['x','y','width','height'].every(k=>Math.abs(c.bounds[k]-learnedClick.bounds[k])<=2));
          const learnedSaved=Boolean(learnedClick && artifacts.promote(learnedClick,sameFrameTarget?imageBeforeManual:null));
          log('adapter.retry_finished',{stage,result:'complete',learned:learnedSaved});
          return {state:'complete',value:result.value};
        }
      }
      if (started && idleError(snapshot) && Date.now() > waitUntil) {
        log('adapter.retry_stage_result',{stage,result:'page_error_after_retry'});return {state:'failed'};
      }
      // A stale DOM stop flag is not evidence of a NEW request. Bound the
      // no-request window even if that flag sticks; each later stage still
      // refuses to click while an actual tracked request remains in flight.
      if (!started && Date.now() >= waitUntil) {
        log('adapter.retry_stage_result',{stage,result:manual?'manual_wait_expired':'no_new_generation'});return {state:'no_request'};
      }
      // Never issue another automatic click while any generation is pending.
      if(Date.now()+200>=deadline)break;
      await sleep();
    }
    return {state:'timeout'};
  }
  try {
    log('adapter.retry_pipeline_started',{original_code:ctx.cause.code,source:job.request_source || 'unknown',purpose:job.purpose || 'candidate',policy:['dom_handler','screenshot_click','manual'],manual_wait_seconds:manualWait/1000});
    // Allow the failed request's error panel/footer to paint before trying it.
    const paintUntil = Math.min(deadline,Date.now()+triggerWait);
    while(!idleError(lastSnapshot) && Date.now()<paintUntil){
      if(lastSnapshot.responsePending || lastSnapshot.stopping)break;
      await sleep();lastSnapshot=await observe(true);
    }
    for(const stage of ['dom_handler','screenshot_click']) {
      if(Date.now()>=deadline)break;
      const checkpoint = guardCheckpoint;
      let baseline=lastSnapshot, dispatched=false, uncertain=false;
      log('adapter.retry_stage_started',{stage,attempt:++attemptNo,checkpoint,remaining_seconds:Math.max(0,Math.ceil((deadline-Date.now())/1000))});
      status('retrying',stage==='dom_handler'?'Qwen 恢复第 1/3 级：检查并触发本轮重试…':'Qwen 恢复第 2/3 级：截图并核验原生点击目标…');
      try {
        await acquire();
        baseline=lastSnapshot=await observe(true);
        if(mark().responseCount>checkpoint.responseCount || !idleError(baseline)){
          log('adapter.retry_stage_skipped',{stage,reason:'not_idle_current_turn_error',current_error:Boolean(baseline.recovery?.currentError),context_valid:Boolean(baseline.recovery?.contextValid),stopping:Boolean(baseline.stopping),pending:Boolean(baseline.responsePending),stale_stop_ignored:Boolean(baseline.recovery?.staleStopIgnored),context_reason:baseline.recovery?.reason});
        }else if(stage==='dom_handler'){
          status('retrying','Qwen 连接失败：正在触发当前回合的重试机制（第 1 级）…');
          if(baseline.recovery?.retryRevealable){
            const revealed=await act('recoveryReveal');
            log('adapter.retry_reveal',{ready:revealed.ready,reason:revealed.reason});
            lastSnapshot=await observe(true);
          }
          const target=await act('recoveryTrigger',{learned:learned?.descriptor});
          dispatched=target?.dispatched===true;
          log('adapter.recovery_retry',{stage,attempt:1,dispatched,target});
        }else if(job.qwen_retry_screenshot!==false){
          status('retrying','Qwen 重试未恢复：正在截图定位并模拟点击当前回合的重试控件（第 2 级）…');
          const report=await act('recoveryVisual',{learned:learned?.descriptor});
          log('adapter.retry_visual_candidates',{ready:report.ready,reason:report.reason,candidates:report.candidates || [],viewport:report.viewport});
          const image=await capture('02-visual',report.viewport);
          if(report.ready){
            if(image){
              const selection=selectVisualTarget(image,report,learned);
              log('adapter.retry_visual_match',{reason:selection.reason,candidates:selection.candidates});
              if(selection.target && mark().responseCount===checkpoint.responseCount && !network.state?.().pending){
                const candidate=selection.target;
                const target=await act('recoveryVisualClaim',{token:candidate.token,bounds:candidate.bounds});
                log('adapter.retry_visual_claim',{ready:target.ready,reason:target.reason,point:{x:target.x,y:target.y}});
                if(target.ready && mark().responseCount===checkpoint.responseCount && !network.state?.().pending){
                  // Reserve before native input; an ambiguous acknowledgement
                  // can only fall back to a human, not another automatic gesture.
                  dispatched=true;
                  await dispatch(target);
                  log('adapter.recovery_retry',{stage,attempt:2,dispatched:true,point:{x:target.x,y:target.y}});
                }
              }
            }
          }
        }else log('adapter.retry_stage_skipped',{stage,reason:'screenshot_disabled'});
        if(dispatched && ctx.settle)await ctx.settle(stage,checkpoint,baseline);
      }catch(e){
        if(ctx.signal?.aborted || ['recovery_context_changed','provider_origin_changed','qwen_model_changed','webpage_closed'].includes(e.code))throw e;
        uncertain=dispatched;
        log('adapter.retry_stage_error',{stage,code:e.code||e.message,dispatched,outcome_unknown:uncertain});
      }finally{await release();}
      const result=await waitResult(checkpoint,baseline,stage,Math.min(deadline,Date.now()+(dispatched?triggerWait:0)));
      if(result.state==='complete')return result.value;
      if(result.state==='timeout' || uncertain)break;
      if(result.state==='failed')guardCheckpoint=mark();
    }
    if(Date.now()>=deadline)throw fail('recovery_timeout','Qwen 重试总时限已到，未取得完整回答。');
    // Capture before the trusted user click can replace the failed response UI.
    try{
      await acquire();
      const report=await act('recoveryVisual',{learned:learned?.descriptor,capture_only:true});
      manualImageCandidates=report.candidates || [];
      imageBeforeManual=await capture('03-before-manual',report.viewport);
    }catch(e){if(ctx.signal?.aborted || ['recovery_context_changed','provider_origin_changed'].includes(e.code))throw e;log('adapter.retry_manual_snapshot_failed',{code:e.code||e.message});}
    finally{await release();}
    log('adapter.retry_stage_started',{stage:'manual',attempt:++attemptNo});
    const expires=Math.min(deadline,Date.now()+manualWait);
    const checkpoint=guardCheckpoint,baseline=await observe(true);
    const watch=await act('recoveryWatchStart',{expires});
    log('adapter.retry_manual_watch',{ready:watch.ready,reason:watch.reason,expires});
    log('adapter.recovery_manual_required',{reason:'automatic_stages_exhausted',remaining_seconds:Math.ceil((expires-Date.now())/1000)});
    status('manual_retry_required',`请点击“处理网页重试”打开 Qwen，并在原会话点击重试。等待 ${Math.ceil((expires-Date.now())/1000)} 秒；成功恢复后会保存点击控件供下次重试。`);
    const result=await waitResult(checkpoint,baseline,'manual',expires,true);
    if(result.state==='complete')return result.value;
    throw fail(result.state==='timeout'?'recovery_timeout':'qwen_manual_retry_timeout',
      result.state==='failed'?'用户重试后仍收到 Qwen 错误，已保存各级尝试日志；没有重新填写问题或刷新页面。':
      '等待用户重试结束，未取得完整回答。各级重试和点击诊断已保存；没有重新填写问题或刷新页面。');
  }catch(error){
    log('adapter.retry_finished',{result:ctx.signal?.aborted?'cancelled':'failed',code:error.code || 'retry_error',attempts:attemptNo,remaining_seconds:Math.max(0,Math.ceil((deadline-Date.now())/1000))});
    throw error;
  }finally{
    try{const stopped=await act('recoveryWatchStop');log('adapter.retry_watch_stopped',{clicks:stopped.clicks?.length||0});}catch{}
    await release();
  }
}
module.exports={runQwenRecovery,RetryArtifacts,imageFeature,featureSimilarity,selectVisualTarget,safeDescriptor};
