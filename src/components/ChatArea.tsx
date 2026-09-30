import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send, Loader2, Bot, User, AlertCircle, Sparkles,
  Paperclip, Image, FileText, X, File as FileIcon, RotateCcw, Pencil,
  Copy, Download, FolderPlus, Volume2, StopCircle, Puzzle, Globe, ThumbsUp, Wand2, Server,
  Settings as SettingsIcon, Link2, ChevronRight, ChevronDown, MessagesSquare,
  CheckCircle2, XCircle, Loader, AlertTriangle, Sparkle, FileCode2, PlayCircle, Hammer,
} from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import RichContentRenderer from './RichContentRenderer';
import AgentDialog from './AgentDialog';
import type { APIProvider, ChatMessage, Conversation, FileAttachment, PluginResult, PluginProgressEvent } from '../types';
import { isDesktopApp, type WebChatTarget } from '../lib/desktopBridge';

interface Props {
  conversation: Conversation | null;
  provider: APIProvider | null;
  onSendMessage: (content: string, attachments?: FileAttachment[], options?: { webSearch?: boolean; webChatTargets?: string[] }) => void;
  isLoading: boolean;
  streamingContent: string;
  injectedInput?: string | null;
  injectedAttachments?: FileAttachment[] | undefined;
  onInjectedInputConsumed?: () => void;
  onResend?: (convId: string, userMsg: ChatMessage, errorMsgId: string) => void;
  onEditUserMessage?: (convId: string, msgId: string, content: string, attachments?: FileAttachment[]) => void;
  onLikeMessage?: (convId: string, msgId: string) => void;
  pluginEnabled?: boolean;
  onPluginEnabledChange?: (v: boolean) => void;
  onPluginRun?: (convId: string, messageId: string, pluginName: string) => void;
  onPluginChat?: (convId: string, messageId: string, pluginName: string, message: string, code: string, context?: string) => void;
  onPluginReloadCode?: (pluginName: string) => Promise<string | null>;
  /** 打开「通用设置」对话框（模型参数 + Web 搜索）。 */
  onOpenSettings?: () => void;
  /** 当前是否有任意请求在飞行中：普通 chat / 插件流水线 / 插件运行/修改。 */
  isBusy?: boolean;
  /** 终止当前请求。 */
  onStop?: () => void;
  /** "自动选模型"开关：开启后由意图分析路由到对应角色模型，必要时新建会话。 */
  autoRouteEnabled?: boolean;
  onAutoRouteEnabledChange?: (v: boolean) => void;
  /** auto-route 命中「代码编写」时，请求打开 AI 工作流（多文件工程、自动开跑）。 */
  agentRequest?: { goal: string; nonce: number } | null;
  onAgentRequestConsumed?: () => void;
  /** Electron 中已打开且可识别的 AI 网页标签。 */
  webChatTargets?: WebChatTarget[];
  webChatAggregator?: { providerName: string; model: string; usesBasicModel: boolean } | null;
  onWebChatSelectionChange?: (enabled: boolean, ids: string[]) => void;
  onOpenWebChatSite?: (url: string, title?: string) => void;
  onOpenUrl?: (url: string, title?: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function ChatArea({ conversation, provider, onSendMessage, isLoading, streamingContent, injectedInput, injectedAttachments, onInjectedInputConsumed, onResend, onEditUserMessage, onLikeMessage, pluginEnabled, onPluginEnabledChange, onPluginRun, onPluginChat, onPluginReloadCode, onOpenSettings, isBusy, onStop, autoRouteEnabled, onAutoRouteEnabledChange, agentRequest, onAgentRequestConsumed, webChatTargets = [], webChatAggregator, onWebChatSelectionChange, onOpenWebChatSite, onOpenUrl }: Props) {
  const busy = !!(isBusy ?? isLoading);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [showAgentDialog, setShowAgentDialog] = useState(false);
  const [agentInitialGoal, setAgentInitialGoal] = useState('');
  const [agentMode, setAgentMode] = useState<'script' | 'project'>('script');
  const [agentAutoStart, setAgentAutoStart] = useState(false);
  const [webChatEnabled, setWebChatEnabled] = useState(false);
  const [showWebChatMenu, setShowWebChatMenu] = useState(false);
  const [selectedWebChatIds, setSelectedWebChatIds] = useState<string[]>([]);
  const knownWebChatIdsRef = useRef<Set<string>>(new Set());
  const desktopWebChatAvailable = isDesktopApp();
  const webChatTargetSignature = webChatTargets.map(target => `${target.id}:${target.url}`).join('|');

  // 新打开的 AI 网页默认选中；关闭标签后自动清理，用户手动取消的标签不会被反复选回。
  useEffect(() => {
    const currentIds = new Set(webChatTargets.map(target => target.id));
    const newlyOpened = webChatTargets
      .map(target => target.id)
      .filter(id => !knownWebChatIdsRef.current.has(id));
    setSelectedWebChatIds(previous => {
      const kept = previous.filter(id => currentIds.has(id));
      return [...new Set([...kept, ...newlyOpened])].slice(0, Math.max(2, kept.length));
    });
    knownWebChatIdsRef.current = currentIds;
    if (currentIds.size === 0) setWebChatEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webChatTargetSignature]);

  useEffect(() => {
    onWebChatSelectionChange?.(webChatEnabled, selectedWebChatIds);
  }, [webChatEnabled, selectedWebChatIds, onWebChatSelectionChange]);

  // App 请求打开 AI 工作流（代码编写自动流程）
  useEffect(() => {
    if (!agentRequest) return;
    setAgentInitialGoal(agentRequest.goal);
    setAgentMode('project');
    setAgentAutoStart(true);
    setShowAgentDialog(true);
    onAgentRequestConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentRequest?.nonce]);

  useEffect(() => {
    if (injectedInput != null) {
      setInput(injectedInput);
      setAttachments(injectedAttachments ?? []);
      onInjectedInputConsumed?.();
    }
  }, [injectedInput, injectedAttachments]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation?.messages, streamingContent]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newAttachments: FileAttachment[] = [];

    for (const file of Array.from(files)) {
      const attachment: FileAttachment = {
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        size: file.size,
      };

      if (file.type.startsWith('image/')) {
        // Read image as data URL for preview and sending
        const dataUrl = await readFileAsDataUrl(file);
        attachment.dataUrl = dataUrl;
      } else {
        // Read text content for text-based files
        const textTypes = [
          'text/', 'application/json', 'application/xml', 'application/javascript',
          'application/typescript', 'application/x-python', 'application/x-sh',
          'application/yaml', 'application/x-yaml', 'application/csv',
        ];
        const isText = textTypes.some(t => file.type.startsWith(t)) ||
          file.name.match(/\.(txt|md|py|js|ts|jsx|tsx|css|html|json|xml|yaml|yml|sh|bash|c|cpp|h|java|go|rs|rb|php|sql|csv|log|env|ini|toml|cfg)$/i);

        if (isText) {
          const content = await readFileAsText(file);
          attachment.content = content;
        } else {
          // Binary file - read as data URL
          const dataUrl = await readFileAsDataUrl(file);
          attachment.dataUrl = dataUrl;
        }
      }

      newAttachments.push(attachment);
    }

    setAttachments(prev => [...prev, ...newAttachments]);
    e.target.value = '';
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const handleSend = () => {
    if ((!input.trim() && attachments.length === 0) || busy) return;
    if (webChatEnabled && selectedWebChatIds.length === 0) {
      setShowWebChatMenu(true);
      return;
    }
    const sendOptions = {
      ...(useWebSearch ? { webSearch: true } : {}),
      ...(webChatEnabled ? { webChatTargets: selectedWebChatIds } : {}),
    };
    onSendMessage(
      input.trim(),
      attachments.length > 0 ? attachments : undefined,
      Object.keys(sendOptions).length ? sendOptions : undefined,
    );
    setShowWebChatMenu(false);
    setInput('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 来自 MarkdownRenderer 中代码块/终端的「引用到输入」回调
  const handleQuoteToInput = useCallback((text: string) => {
    if (!text) return;
    setInput(prev => (prev ? prev.replace(/\s+$/, '') + '\n\n' : '') + text);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
      }
    }, 0);
  }, []);

  // 「引用并立即发送」：直接走 onSendMessage，不污染当前输入
  const handleQuoteToInputAndSend = useCallback((text: string) => {
    if (!text || !provider || busy) return;
    onSendMessage(text);
  }, [onSendMessage, provider, busy]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            id: crypto.randomUUID(),
            name: `pasted_image_${Date.now()}.png`,
            type: file.type,
            size: file.size,
            dataUrl: reader.result as string,
          }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Create a synthetic event-like object
    const fakeInput = { target: { files, value: '' } } as any;
    handleFileSelect(fakeInput);
  }, [handleFileSelect]);

  // Empty state
  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-850 text-gray-400 p-8">
        <div className="max-w-md text-center">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-500/20">
            <Sparkles size={36} className="text-white" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">LLM API Manager</h2>
          <p className="text-gray-400 mb-4 leading-relaxed">
            Configure your API providers, select a model, and start chatting.
            Supports OpenAI, Claude, DeepSeek, and any OpenAI-compatible API.
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs text-gray-500 mb-6">
            <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
              <Image size={16} className="mx-auto mb-1.5 text-blue-400" />
              Upload images & files
            </div>
            <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
              <FileText size={16} className="mx-auto mb-1.5 text-green-400" />
              Run code & preview HTML
            </div>
          </div>
          {!provider && (
            <div className="flex items-center gap-2 text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-4 py-3 text-sm">
              <AlertCircle size={16} />
              <span>Please add and select an API provider first</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const messages = conversation.messages;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-gray-850 min-w-0">
      {/* Chat Header */}
      <div className="border-b border-gray-700 px-6 py-3 bg-gray-900/50 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-white truncate">{conversation.title}</h2>
          <div className="flex items-center gap-2 text-xs text-gray-400 shrink-0">
            {provider && (
              <>
                <span className="bg-gray-700 px-2 py-1 rounded">{provider.name}</span>
                <span className="bg-gray-700 px-2 py-1 rounded font-mono">{provider.selectedModel}</span>
              </>
            )}
            <button
              onClick={async () => {
                let url = 'http://127.0.0.1:8080';
                try {
                  const r = await fetch('/api/local-hub/url');
                  if (r.ok) { const j = await r.json(); url = j?.url || url; }
                } catch {}
                window.open(url, '_blank', 'noopener,noreferrer');
              }}
              title="打开本地模型 Hub（管理 llama-server / 下载 GGUF）"
              className="p-1.5 rounded text-gray-400 hover:text-cyan-300 hover:bg-gray-700/60"
            >
              <Server size={14} />
            </button>
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="通用设置（模型参数 + Web 搜索）"
                className="p-1.5 rounded text-gray-400 hover:text-cyan-300 hover:bg-gray-700/60"
              >
                <SettingsIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full py-20 text-gray-500">
              <p>Send a message to start the conversation</p>
            </div>
          )}

          {messages.map((msg, idx) => {
            const prevUser = msg.role === 'assistant' ? messages.slice(0, idx).reverse().find(m => m.role === 'user') : undefined;
            const isError = msg.role === 'assistant' && msg.content.includes('❌ **Error**');
            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                conversationId={conversation.id}
                previousUserMessage={prevUser}
                isError={isError}
                onResend={onResend}
                onEditUserMessage={onEditUserMessage}
                onLikeMessage={onLikeMessage}
                ttsAudioRef={ttsAudioRef}
                ttsPlaying={ttsPlaying}
                setTtsPlaying={setTtsPlaying}
                onPluginRun={onPluginRun}
                onPluginChat={onPluginChat}
                onPluginReloadCode={onPluginReloadCode}
                provider={provider}
                onQuoteToInput={handleQuoteToInput}
                onQuoteToInputAndSend={handleQuoteToInputAndSend}
                busy={busy}
                onStop={onStop}
                onOpenUrl={onOpenUrl}
              />
            );
          })}

          {isLoading && streamingContent && (
            <div className="px-6 py-5 flex gap-4">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center shrink-0 mt-0.5">
                <Bot size={16} className="text-white" />
              </div>
              <div className="flex-1 min-w-0 select-text [&_*]:select-text">
                <MarkdownRenderer
                  content={streamingContent}
                  onQuoteToInput={handleQuoteToInput}
                  onQuoteToInputAndSend={handleQuoteToInputAndSend}
                  onOpenUrl={onOpenUrl}
                />
                <span className="inline-block w-2 h-5 bg-blue-400 animate-pulse ml-0.5 align-middle" />
              </div>
            </div>
          )}

          {(() => {
            // 当最后一条消息是仍在流式更新的插件消息（有 pluginProgress、还没拿到 pluginResult）时，
            // 时间线本身已经是“正在进行”的可视化，无需再叠一条 "Thinking..."。
            const last = conversation?.messages[conversation.messages.length - 1];
            const inFlightPlugin = !!(last && last.role === 'assistant' && last.pluginProgress && !last.pluginResult);
            const inFlightWebChat = !!(last?.webChat && ['running', 'synthesizing'].includes(last.webChat.status));
            if (!isLoading || streamingContent || inFlightPlugin || inFlightWebChat) return null;
            return (
              <div className="px-6 py-5 flex gap-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center shrink-0">
                  <Bot size={16} className="text-white" />
                </div>
                <div className="flex items-center gap-2 text-gray-400">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Thinking...</span>
                </div>
              </div>
            );
          })()}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-gray-700 p-4 bg-gray-900/30 shrink-0"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="max-w-4xl mx-auto">
          {/* Attachment Preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3 p-3 bg-gray-800/50 rounded-xl border border-gray-700/50">
              {attachments.map(att => (
                <div key={att.id} className="relative group">
                  {att.type.startsWith('image/') && att.dataUrl ? (
                    <div className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-600">
                      <img src={att.dataUrl} alt={att.name} className="w-full h-full object-cover" />
                      <button
                        onClick={() => removeAttachment(att.id)}
                        className="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2 pr-8 border border-gray-600/50">
                      <FileIcon size={16} className="text-blue-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs text-gray-200 truncate max-w-[120px]">{att.name}</div>
                        <div className="text-xs text-gray-500">{formatFileSize(att.size)}</div>
                      </div>
                      <button
                        onClick={() => removeAttachment(att.id)}
                        className="absolute -top-1 -right-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 items-end">
            <div className="relative flex gap-1 shrink-0">
              {onAutoRouteEnabledChange != null && (
                <button
                  type="button"
                  onClick={() => onAutoRouteEnabledChange(!autoRouteEnabled)}
                  disabled={!provider || busy}
                  title={autoRouteEnabled
                    ? '关闭自动选模型（按意图分类自动路由 + 自动新建对话）'
                    : '开启自动选模型（按意图分类自动路由到默认模型 / 必要时新建对话）'}
                  className={`p-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${autoRouteEnabled ? 'text-cyan-400 bg-cyan-500/20' : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800'}`}
                >
                  <Sparkles size={20} />
                </button>
              )}
              {onPluginEnabledChange != null && (
                <button
                  type="button"
                  onClick={() => onPluginEnabledChange(!pluginEnabled)}
                  disabled={!provider || busy}
                  title={pluginEnabled ? '关闭插件' : '开启插件'}
                  className={`p-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${pluginEnabled ? 'text-purple-400 bg-purple-500/20' : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800'}`}
                >
                  <Puzzle size={20} />
                </button>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.py,.js,.ts,.jsx,.tsx,.css,.html,.json,.xml,.yaml,.yml,.sh,.bash,.c,.cpp,.h,.java,.go,.rs,.rb,.php,.sql,.csv,.log,.pdf,.doc,.docx,.xls,.xlsx,.zip,.tar,.gz,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp"
                onChange={handleFileSelect}
                className="hidden"
              />
              <button
                onClick={() => imageInputRef.current?.click()}
                disabled={!provider || busy}
                className="p-2.5 text-gray-400 hover:text-blue-400 hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Upload Image"
              >
                <Image size={20} />
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!provider || busy}
                className="p-2.5 text-gray-400 hover:text-blue-400 hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Attach File"
              >
                <Paperclip size={20} />
              </button>
              <button
                onClick={() => setUseWebSearch(v => !v)}
                disabled={!provider || busy}
                title={useWebSearch ? '关闭联网搜索' : '开启联网搜索 (DuckDuckGo)'}
                className={`p-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${useWebSearch ? 'text-emerald-400 bg-emerald-500/20' : 'text-gray-400 hover:text-emerald-400 hover:bg-gray-800'}`}
              >
                <Globe size={20} />
              </button>
              <button
                type="button"
                onClick={() => setShowWebChatMenu(open => !open)}
                disabled={!provider || busy || !desktopWebChatAvailable}
                title={desktopWebChatAvailable
                  ? (webChatEnabled ? `网页群聊已开启（${selectedWebChatIds.length} 个网页）` : '配置网页 AI 群聊')
                  : '网页 AI 群聊仅在 Electron 桌面版可用'}
                className={`p-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  webChatEnabled ? 'text-fuchsia-300 bg-fuchsia-500/20' : 'text-gray-400 hover:text-fuchsia-300 hover:bg-gray-800'
                }`}
              >
                <MessagesSquare size={20} />
              </button>
              {showWebChatMenu && (
                <div className="absolute z-40 bottom-full left-0 mb-2 w-80 rounded-xl border border-fuchsia-500/30 bg-gray-900 p-3 shadow-2xl">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div>
                      <div className="text-xs font-medium text-white">网页 AI 群聊</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        默认选择 2 个网页，由基本对话模型综合
                      </div>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] text-fuchsia-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={webChatEnabled}
                        onChange={event => setWebChatEnabled(event.target.checked)}
                        className="accent-fuchsia-500"
                      />
                      启用
                    </label>
                  </div>
                  <div className="mb-2 rounded border border-fuchsia-500/20 bg-fuchsia-950/20 px-2.5 py-2 text-[10px] text-gray-400">
                    综合模型：
                    <span className="ml-1 text-fuchsia-300">
                      {webChatAggregator
                        ? `${webChatAggregator.providerName} / ${webChatAggregator.model}`
                        : (provider?.selectedModel || '未选择')}
                    </span>
                    <span className="ml-1 text-gray-600">
                      （{webChatAggregator?.usesBasicModel ? '基本对话模型' : '当前选择模型'}）
                    </span>
                  </div>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {webChatTargets.length === 0 ? (
                      <div className="rounded border border-gray-700 bg-gray-800/60 px-2.5 py-2 text-[11px] text-gray-400">
                        尚未打开 AI 聊天网页。请先打开并登录，然后返回“对话”标签。
                      </div>
                    ) : webChatTargets.map(target => (
                      <label key={target.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedWebChatIds.includes(target.id)}
                          onChange={event => setSelectedWebChatIds(previous => event.target.checked
                            ? [...new Set([...previous, target.id])]
                            : previous.filter(id => id !== target.id))}
                          className="accent-fuchsia-500"
                        />
                        <span className="text-xs text-gray-200 capitalize">{target.site}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-gray-500" title={target.url}>{target.title}</span>
                      </label>
                    ))}
                  </div>
                  <div className="my-2 border-t border-gray-700" />
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      ['DeepSeek', 'https://chat.deepseek.com/'],
                      ['Qwen', 'https://chat.qwen.ai/'],
                      ['ChatGPT', 'https://chatgpt.com/'],
                      ['Grok', 'https://grok.com/'],
                      ['Claude', 'https://claude.ai/new'],
                      ['Gemini', 'https://gemini.google.com/app'],
                      ['Poe', 'https://poe.com/'],
                    ].map(([name, url]) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => onOpenWebChatSite?.(url, name)}
                        className="rounded bg-gray-800 px-2 py-1.5 text-[11px] text-gray-300 hover:bg-gray-700 hover:text-white"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 text-[10px] text-gray-600">需要网页保持登录；网页改版时可能需要刷新后重试。</div>
                </div>
              )}
              <button
                onClick={() => {
                  setAgentInitialGoal(input.trim());
                  setAgentMode('script');
                  setAgentAutoStart(false);
                  setShowAgentDialog(true);
                }}
                disabled={!provider}
                title={input.trim() ? 'AI 工作流（已带入当前输入作为需求）' : 'AI 工作流：需求 → 步骤 → 脚本 → 执行'}
                className="p-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-gray-400 hover:text-purple-400 hover:bg-gray-800"
              >
                <Wand2 size={20} />
              </button>
            </div>

            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={provider ? "Type message... (Shift+Enter for new line, paste images)" : "Select a provider first..."}
                disabled={!provider || busy}
                rows={1}
                className="w-full bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none disabled:opacity-50 disabled:cursor-not-allowed text-sm leading-relaxed"
              />
            </div>
            {busy && onStop ? (
              <button
                onClick={onStop}
                title="停止当前对话 / 插件运行"
                className="bg-red-600 hover:bg-red-500 text-white p-3 rounded-xl transition-colors shrink-0 flex items-center justify-center"
              >
                <StopCircle size={20} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={(!input.trim() && attachments.length === 0) || busy || !provider}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white p-3 rounded-xl transition-colors shrink-0"
              >
                {busy ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
              </button>
            )}
          </div>
          <div className="text-xs text-gray-600 mt-1.5 px-1 flex items-center gap-2 flex-wrap">
            <span>Drag & drop or paste images • Attach files to include in context</span>
            {webChatEnabled && (
              <span className="text-fuchsia-400">
                网页群聊：{selectedWebChatIds.length} 个网页 → {webChatAggregator
                  ? `${webChatAggregator.providerName} / ${webChatAggregator.model}`
                  : (provider?.selectedModel || '当前模型')} 综合
              </span>
            )}
          </div>
        </div>
      </div>

      {/* AI 工作流模态对话框：需求 → 步骤 → 脚本+参数 → 执行 */}
      <AgentDialog
        visible={showAgentDialog}
        provider={provider}
        initialGoal={agentInitialGoal}
        mode={agentMode}
        autoStart={agentAutoStart}
        onClose={() => setShowAgentDialog(false)}
      />
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function stripMarkdownForTTS(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~`]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function AssistantActions({
  content,
  previousUserMessage,
  conversationId,
  messageId,
  onResend,
  isError,
  ttsAudioRef,
  ttsPlaying,
  setTtsPlaying,
  metrics,
  onLikeMessage,
}: {
  content: string;
  previousUserMessage?: ChatMessage;
  conversationId: string;
  messageId: string;
  onResend?: (convId: string, userMsg: ChatMessage, errorMsgId: string) => void;
  isError: boolean;
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>;
  ttsPlaying?: boolean;
  setTtsPlaying?: (v: boolean) => void;
  metrics?: import('../types').MessageMetrics;
  onLikeMessage?: (convId: string, msgId: string) => void;
}) {
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
  };
  const handleSaveMd = async () => {
    const name = prompt('保存为 Markdown 文件名', `response_${Date.now()}.md`) || '';
    if (!name.trim()) return;
    try {
      const res = await fetch('/api/save-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name.trim(), content }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || '保存失败');
      }
    } catch (e: any) {
      alert(e.message || '保存失败');
    }
  };
  const handleToProject = async () => {
    const folder = prompt('项目文件夹名', `project_${Date.now()}`) || '';
    if (!folder.trim()) return;
    try {
      const res = await fetch('/api/markdown-to-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, folder: folder.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) alert(d.error || '失败');
      else if (d.saved?.length) alert(`已保存 ${d.saved.length} 个文件到 ${d.folder}`);
      else alert('未解析到代码块');
    } catch (e: any) {
      alert(e.message || '失败');
    }
  };
  const handleSpeech = async () => {
    if (ttsAudioRef?.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      if (ttsAudioRef.current.src.startsWith('blob:')) URL.revokeObjectURL(ttsAudioRef.current.src);
      ttsAudioRef.current = null;
      setTtsPlaying?.(false);
      return;
    }
    const text = stripMarkdownForTTS(content).slice(0, 5000);
    if (!text.trim()) return;
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), speed: 1, seed: 412 }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || `TTS 请求失败 ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsAudioRef!.current = audio;
      setTtsPlaying?.(true);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        ttsAudioRef!.current = null;
        setTtsPlaying?.(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        ttsAudioRef!.current = null;
        setTtsPlaying?.(false);
      };
      await audio.play();
    } catch (e: any) {
      alert(e.message || '语音播报失败');
      setTtsPlaying?.(false);
    }
  };
  const liked = !!metrics?.liked;
  const tokens = metrics?.totalTokens
    ?? (((metrics?.promptTokens ?? 0) + (metrics?.completionTokens ?? 0)) || undefined);
  const dur = metrics?.durationMs;
  const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {/* 指标条：tokens + 响应时间，仅当有数据时显示 */}
      {(tokens != null || dur != null) && !isError && (
        <span className="text-[11px] text-gray-500 mr-2 font-mono whitespace-nowrap">
          {tokens != null && (
            <span title={`prompt ${metrics?.promptTokens ?? 0} / completion ${metrics?.completionTokens ?? 0}`}>
              {tokens} tok
            </span>
          )}
          {tokens != null && dur != null && <span className="text-gray-700"> · </span>}
          {dur != null && <span title="本次响应耗时（含网络）">{formatDuration(dur)}</span>}
        </span>
      )}
      <button onClick={handleCopy} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-700" title="复制全部内容">
        <Copy size={14} />
      </button>
      <button onClick={handleSaveMd} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-700" title="保存为 Markdown 文件">
        <Download size={14} />
      </button>
      <button onClick={handleToProject} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-700" title="解析代码块并保存为项目文件">
        <FolderPlus size={14} />
      </button>
      <button onClick={handleSpeech} className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-700" title={ttsPlaying ? '停止播报' : '语音播报'}>
        {ttsPlaying ? <StopCircle size={14} className="text-red-400" /> : <Volume2 size={14} />}
      </button>
      {/* 点赞 —— 紧贴在「重新生成」左侧 */}
      {onLikeMessage && !isError && (
        <button
          onClick={() => onLikeMessage(conversationId, messageId)}
          className={`p-1.5 rounded hover:bg-gray-700 ${liked ? 'text-emerald-400' : 'text-gray-500 hover:text-emerald-300'}`}
          title={liked ? '已点赞，再点取消' : '点赞此回答（计入模型评价）'}
        >
          <ThumbsUp size={14} className={liked ? 'fill-current' : ''} />
        </button>
      )}
      {previousUserMessage && onResend && (
        <button
          onClick={() => onResend(conversationId, previousUserMessage, messageId)}
          className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-gray-700"
          title={isError ? '重新发送' : '重新生成'}
        >
          <RotateCcw size={14} />
        </button>
      )}
    </div>
  );
}

function PluginResultDisplay({
  result,
  conversationId,
  messageId,
  provider,
  onPluginRun,
  onPluginChat,
  onPluginReloadCode,
  busy,
  onStop,
}: {
  result: PluginResult;
  conversationId: string;
  messageId: string;
  provider: APIProvider | null;
  onPluginRun?: (convId: string, msgId: string, name: string) => void;
  onPluginChat?: (convId: string, msgId: string, name: string, msg: string, code: string, context?: string) => void;
  onPluginReloadCode?: (name: string) => Promise<string | null>;
  /** 当前是否有任意请求在飞行中（普通 chat / 插件流水线 / 插件运行/修改）。 */
  busy?: boolean;
  /** 终止当前请求。 */
  onStop?: () => void;
}) {
  const [showEditor, setShowEditor] = useState(false);
  const [editingCode, setEditingCode] = useState(result.code ?? '');
  const [chatInput, setChatInput] = useState('');
  const [chatContext, setChatContext] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);
  const pluginName = result.plugin_name ?? '';
  const loading = !!busy;

  const handleOpenEditor = async () => {
    if (!showEditor && onPluginReloadCode) {
      const code = await onPluginReloadCode(pluginName);
      if (code != null) setEditingCode(code);
    }
    setShowEditor(!showEditor);
  };

  const handleRun = () => {
    if (onPluginRun && !loading) {
      onPluginRun(conversationId, messageId, pluginName);
    }
  };

  const handleChatSubmit = () => {
    if (chatInput.trim() && onPluginChat && provider && !loading) {
      onPluginChat(conversationId, messageId, pluginName, chatInput.trim(), editingCode, chatContext.trim() || undefined);
      setChatInput('');
      setChatContext('');
    }
  };

  /** 把当前结果中的错误日志（stderr / 最后一条 error 状态 / stdout）拼成一段引用文本。 */
  const buildErrorContext = (): string => {
    const parts: string[] = [];
    const r = result.result;
    if (r && typeof r === 'object' && r.type === 'mixed' && Array.isArray(r.content)) {
      for (const it of r.content) {
        if (it && typeof it === 'object' && (it as { type?: string }).type === 'status'
            && ((it as { status?: string }).status === 'error' || (it as { status?: string }).status === 'warning')) {
          const m = (it as { message?: string }).message;
          if (m) parts.push(`[${(it as { status?: string }).status}] ${m}`);
        }
      }
    }
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (result.returncode != null && result.returncode !== 0) parts.push(`[exit_code] ${result.returncode}`);
    if (parts.length === 0 && result.stdout) parts.push(`[stdout]\n${result.stdout}`);
    return parts.join('\n').trim();
  };

  const handleQuoteError = () => {
    const ctx = buildErrorContext();
    if (!ctx) return;
    setChatContext(prev => prev ? `${prev}\n---\n${ctx}` : ctx);
    if (!showEditor) setShowEditor(true);
  };

  const handleQuoteSelection = () => {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    const text = sel?.toString().trim() || '';
    if (!text) {
      alert('请先在上方"执行结果"区域用鼠标选中要引用的文字');
      return;
    }
    if (outputRef.current && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (!outputRef.current.contains(range.commonAncestorContainer)) {
        alert('请只选中"执行结果"区域里的文字');
        return;
      }
    }
    setChatContext(prev => prev ? `${prev}\n---\n${text}` : text);
    if (!showEditor) setShowEditor(true);
  };

  const language = (result.language || 'python').toLowerCase();
  const mainName = language === 'bash' ? 'main.sh' : 'main.py';
  const attempts = result.attempts || [];
  const fixedCount = attempts.length > 1 ? attempts.length - 1 : 0;
  const hasError = !result.success
    || (result.returncode != null && result.returncode !== 0)
    || !!result.stderr;

  return (
    <div className="mt-4 border-t border-gray-700 pt-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-purple-400 font-medium text-sm">🔌 {pluginName}</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${
              language === 'bash'
                ? 'bg-amber-900/40 text-amber-300 border border-amber-700/40'
                : 'bg-blue-900/40 text-blue-300 border border-blue-700/40'
            }`}
            title="脚本语言"
          >
            {language}
          </span>
          {result.needs_sudo && (
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                result.sudo_injected
                  ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/40'
                  : 'bg-red-900/40 text-red-300 border border-red-700/40'
              }`}
              title={result.sudo_injected ? 'sudo 密码已自动注入' : '检测到 sudo 但未保存密码'}
            >
              {result.sudo_injected ? 'sudo ✓' : 'sudo ?'}
            </span>
          )}
          {fixedCount > 0 && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-900/40 text-purple-300 border border-purple-700/40"
              title={`自动修复 ${fixedCount} 次后${result.success ? '通过' : '仍失败'}`}
            >
              auto-fix ×{fixedCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenEditor}
            className={`px-3 py-1.5 text-sm rounded-lg ${showEditor ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
          >
            {showEditor ? '收起' : '编辑代码'}
          </button>
          {loading && onStop ? (
            <button
              type="button"
              onClick={onStop}
              title="停止当前操作"
              className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg flex items-center gap-1"
            >
              <StopCircle size={14} /> 停止
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRun}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50"
            >
              {loading ? '执行中...' : '运行'}
            </button>
          )}
        </div>
      </div>
      <div ref={outputRef} className="bg-gray-800/50 rounded-lg p-4 select-text">
        <RichContentRenderer content={result.result} />
      </div>
      {provider && onPluginChat && (
        <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
          <span className="text-gray-500">基于结果让 AI 修改：</span>
          <button
            type="button"
            onClick={handleQuoteSelection}
            className="px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
            title="先在上方结果中用鼠标选中文字，再点这里把它作为修复上下文"
          >
            引用选中文本
          </button>
          {hasError && (
            <button
              type="button"
              onClick={handleQuoteError}
              className="px-2 py-1 rounded border border-red-700/60 text-red-300 hover:bg-red-900/20"
              title="把 stderr / 错误状态项 / 退出码作为修复上下文"
            >
              引用错误日志
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              if (!showEditor && onPluginReloadCode) {
                const code = await onPluginReloadCode(pluginName);
                if (code != null) setEditingCode(code);
              }
              setShowEditor(true);
            }}
            className="px-2 py-1 rounded border border-purple-700/60 text-purple-300 hover:bg-purple-900/20"
            title="不引用任何上下文，直接手动输入"
          >
            手动输入修改需求
          </button>
        </div>
      )}
      {attempts.length > 1 && (
        <details className="mt-3 border border-gray-700 rounded-lg bg-gray-800/30">
          <summary className="cursor-pointer px-3 py-2 text-xs text-gray-300 hover:text-white select-none">
            自动修复历史 ({attempts.length} 次尝试)
          </summary>
          <ol className="px-3 pb-3 pt-1 space-y-1 text-xs font-mono">
            {attempts.map((a, i) => (
              <li
                key={i}
                className={`flex items-center gap-2 ${a.success ? 'text-emerald-400' : 'text-red-400'}`}
              >
                <span className="text-gray-500">#{a.attempt}</span>
                <span className="text-gray-400">[{a.language || language}]</span>
                <span>{a.success ? '✅ 成功' : '❌ 失败'}</span>
                {a.returncode != null && a.returncode !== 0 && (
                  <span className="text-gray-500">exit={a.returncode}</span>
                )}
                {a.error && <span className="text-gray-500 truncate">{a.error}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {showEditor && (
        <div className="mt-4">
          <div className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-t-lg text-gray-400 text-sm font-mono">{pluginName}/{mainName}</div>
          <textarea
            value={editingCode}
            onChange={e => setEditingCode(e.target.value)}
            className="w-full h-48 p-4 font-mono text-sm text-green-400 bg-gray-900 border border-t-0 border-gray-700 rounded-b-lg resize-y"
            spellCheck={false}
          />
          {provider && onPluginChat && (
            <div className="mt-2 space-y-2">
              {chatContext && (
                <div className="border border-purple-700/40 bg-purple-900/10 rounded-lg p-2">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] uppercase tracking-wide text-purple-300 font-mono">
                      已引用上下文（会与修改需求一并发给 AI）
                    </span>
                    <button
                      type="button"
                      onClick={() => setChatContext('')}
                      className="text-purple-300 hover:text-white text-xs"
                      title="清除引用"
                    >
                      ✕ 清除
                    </button>
                  </div>
                  <textarea
                    value={chatContext}
                    onChange={e => setChatContext(e.target.value)}
                    rows={Math.min(8, Math.max(2, chatContext.split('\n').length))}
                    className="w-full bg-gray-900/60 border border-purple-700/30 rounded px-2 py-1 text-xs font-mono text-purple-100 resize-y"
                    spellCheck={false}
                  />
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleChatSubmit()}
                  placeholder={chatContext
                    ? '描述修改需求（已附带引用上下文）...'
                    : '描述修改需求，AI 修改代码（失败会自动按错误日志再修复，最多 3 次）...'}
                  className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  disabled={loading}
                />
                {loading && onStop ? (
                  <button
                    type="button"
                    onClick={onStop}
                    title="停止当前 AI 修改"
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg flex items-center gap-1"
                  >
                    <StopCircle size={16} /> 停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleChatSubmit}
                    disabled={loading || !chatInput.trim()}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg disabled:opacity-50"
                    title="调用 AI 修改并自动重试（失败 ≤3 次）"
                  >
                    修改
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WebChatAnswersPanel({
  state,
  onOpenUrl,
}: {
  state: NonNullable<ChatMessage['webChat']>;
  onOpenUrl?: (url: string, title?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [hovered, setHovered] = useState<{
    title: string;
    model?: string;
    content: string;
    left: number;
    top: number;
  } | null>(null);

  const latestProgressEvent = state.answers
    .flatMap(answer => answer.events || [])
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  const showPreview = (
    event: React.MouseEvent<HTMLButtonElement>,
    answer: NonNullable<ChatMessage['webChat']>['answers'][number],
  ) => {
    if (!answer.content) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 32);
    setHovered({
      title: answer.title,
      model: answer.model,
      content: answer.content,
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 360)),
    });
  };

  return (
    <div className="mt-4 rounded-xl border border-fuchsia-500/25 bg-gray-900/65 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(value => !value)}
        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/60 ${collapsed ? '' : 'border-b border-gray-700/70'}`}
        title={collapsed ? '展开网页 AI 原始回答' : '折叠网页 AI 原始回答'}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-fuchsia-200">
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <MessagesSquare size={14} />
          网页 AI 原始回答
          <span className="text-[10px] font-normal text-gray-500">（{state.answers.length}）</span>
          {latestProgressEvent && (
            <span className="max-w-64 truncate text-[10px] font-normal text-emerald-300">
              · {latestProgressEvent.message}
            </span>
          )}
        </div>
        <div className="text-[10px] text-gray-400">
          综合：<span className="text-fuchsia-300">{state.aggregator.providerName} / {state.aggregator.model}</span>
          <span className="ml-1 text-gray-600">（{state.aggregator.usesBasicModel ? '基本对话模型' : '当前选择模型'}）</span>
        </div>
      </button>
      {!collapsed && <div className="divide-y divide-gray-800">
        {state.answers.map(answer => (
          <div key={answer.tabId} className="px-3 py-3">
            <div className="flex items-center gap-2">
              {answer.status === 'waiting' ? (
                <Loader size={13} className="shrink-0 animate-spin text-blue-400" />
              ) : answer.status === 'done' ? (
                <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
              ) : (
                <XCircle size={13} className="shrink-0 text-red-400" />
              )}
              <span className="text-xs font-medium text-gray-100">{answer.title}</span>
              <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                {answer.model || answer.site}
              </span>
              <button
                type="button"
                onClick={() => onOpenUrl?.(answer.url, answer.title)}
                onMouseEnter={event => showPreview(event, answer)}
                onMouseLeave={() => setHovered(null)}
                className="ml-auto inline-flex min-w-0 items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 hover:underline"
                title="在应用网页标签中打开；悬停预览回答"
              >
                <Link2 size={11} />
                <span className="max-w-48 truncate">{answer.url}</span>
              </button>
            </div>
            {answer.partial && (
              <div className="mt-2 text-[11px] text-amber-300">等待生成结束超时，显示当前已获取的内容。</div>
            )}
            {!!answer.events?.length && (
              <div className="mt-2 rounded border border-blue-700/30 bg-blue-950/15 px-2 py-1.5">
                <div className="mb-1 text-[10px] font-medium text-blue-300">关键流程</div>
                <div className="space-y-0.5">
                  {answer.events.slice(-10).map((event, index) => (
                    <div
                      key={`${event.timestamp}-${event.event}-${index}`}
                      className="flex items-start gap-1.5 text-[10px] text-gray-400"
                    >
                      <span className="shrink-0 font-mono text-gray-600">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={
                        event.event.includes('failed') || event.event.includes('error')
                          ? 'text-red-300'
                          : event.event === 'page-saved' || event.event === 'markdown-copied'
                            ? 'text-emerald-300'
                            : ''
                      }>
                        {event.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {answer.validation && (
              <div className={`mt-2 rounded border px-2 py-1.5 text-[10px] ${
                answer.validation.complete
                  ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-300'
                  : 'border-amber-700/40 bg-amber-950/20 text-amber-300'
              }`}>
                <div>
                  dump 校验：{answer.validation.complete ? '内容完整' : '可能不完整'}
                  · 已提取 {answer.validation.selectedChars} 字符
                  · dump 最长候选 {answer.validation.dumpMaxCandidateChars} 字符
                </div>
                <div className="mt-0.5 text-gray-500">{answer.validation.reason}</div>
                {answer.extraction?.ok ? (
                  <div className="mt-0.5 text-emerald-300">
                    Markdown 来源：页面复制按钮 · {answer.extraction.copiedChars} 字符
                  </div>
                ) : answer.extraction ? (
                  <div className="mt-0.5 text-amber-300">
                    复制按钮失败，已回退 DOM：{answer.extraction.error || '未获取到剪贴板内容'}
                  </div>
                ) : null}
                {answer.dumpPath && (
                  <div className="mt-0.5 break-all font-mono text-gray-600">校验 dump：{answer.dumpPath}</div>
                )}
                {answer.pagePath && (
                  <div className="mt-0.5 break-all font-mono text-gray-500">完整网页：{answer.pagePath}</div>
                )}
                {answer.pageSaveError && (
                  <div className="mt-0.5 break-all text-red-300">完整网页保存失败：{answer.pageSaveError}</div>
                )}
              </div>
            )}
            {answer.error ? (
              <div className="mt-2 whitespace-pre-wrap text-xs text-red-300">{answer.error}</div>
            ) : answer.content ? (
              <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-gray-950/60 p-3 text-xs leading-relaxed text-gray-300">
                {answer.content}
              </div>
            ) : (
              <div className="mt-2 text-xs text-gray-500">正在等待网页回答…</div>
            )}
          </div>
        ))}
      </div>}
      {!collapsed && hovered && (
        <div
          className="pointer-events-none fixed z-[80] w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-fuchsia-400/40 bg-gray-950 shadow-2xl"
          style={{ left: hovered.left, top: hovered.top }}
        >
          <div className="border-b border-gray-700 px-3 py-2 text-xs font-medium text-white">
            {hovered.title}{hovered.model ? ` · ${hovered.model}` : ''}
          </div>
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 py-3 text-xs leading-relaxed text-gray-200">
            {hovered.content}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  conversationId,
  previousUserMessage,
  isError,
  onResend,
  onEditUserMessage,
  onLikeMessage,
  ttsAudioRef,
  ttsPlaying,
  setTtsPlaying,
  onPluginRun,
  onPluginChat,
  onPluginReloadCode,
  provider,
  onQuoteToInput,
  onQuoteToInputAndSend,
  busy,
  onStop,
  onOpenUrl,
}: {
  message: ChatMessage;
  conversationId: string;
  previousUserMessage?: ChatMessage;
  isError: boolean;
  onResend?: (convId: string, userMsg: ChatMessage, errorMsgId: string) => void;
  onEditUserMessage?: (convId: string, msgId: string, content: string, attachments?: FileAttachment[]) => void;
  onLikeMessage?: (convId: string, msgId: string) => void;
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>;
  ttsPlaying?: boolean;
  setTtsPlaying?: (v: boolean) => void;
  onPluginRun?: (convId: string, messageId: string, pluginName: string) => void;
  onPluginChat?: (convId: string, messageId: string, pluginName: string, message: string, code: string, context?: string) => void;
  onPluginReloadCode?: (pluginName: string) => Promise<string | null>;
  provider: APIProvider | null;
  onQuoteToInput?: (text: string) => void;
  onQuoteToInputAndSend?: (text: string) => void;
  busy?: boolean;
  onStop?: () => void;
  onOpenUrl?: (url: string, title?: string) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div className={`px-6 py-5 flex gap-4 ${isUser ? 'bg-gray-800/30' : ''} group`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
        isUser
          ? 'bg-gradient-to-br from-blue-500 to-blue-700'
          : 'bg-gradient-to-br from-green-500 to-emerald-600'
      }`}>
        {isUser ? <User size={16} className="text-white" /> : <Bot size={16} className="text-white" />}
      </div>
      <div className="flex-1 min-w-0">
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {message.attachments.map(att => (
              <div key={att.id}>
                {att.type.startsWith('image/') && att.dataUrl ? (
                  <div className="rounded-lg overflow-hidden border border-gray-600 max-w-xs">
                    <img src={att.dataUrl} alt={att.name} className="max-w-full max-h-64 object-contain" />
                    <div className="px-2 py-1 bg-gray-800/80 text-xs text-gray-400 truncate">{att.name}</div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-gray-700/40 rounded-lg px-3 py-2 border border-gray-600/50">
                    <FileIcon size={14} className="text-blue-400 shrink-0" />
                    <span className="text-xs text-gray-300 truncate max-w-[150px]">{att.name}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {isUser ? (
          <div className="text-gray-200 whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
        ) : (
          <>
            {message.autoRoute && <AutoRouteBadge info={message.autoRoute} />}
            {message.research && <ResearchPanel info={message.research} />}
            <div className="select-text [&_*]:select-text">
              <MarkdownRenderer
                content={message.content}
                onQuoteToInput={onQuoteToInput}
                onQuoteToInputAndSend={onQuoteToInputAndSend}
                onOpenUrl={onOpenUrl}
              />
            </div>
            {message.webChat && (
              <WebChatAnswersPanel state={message.webChat} onOpenUrl={onOpenUrl} />
            )}
            {message.sources && message.sources.length > 0 && (
              <SourcesList sources={message.sources} />
            )}
            {message.pluginProgress && message.pluginProgress.length > 0 && (
              <PluginProgressTimeline
                events={message.pluginProgress}
                inProgress={!message.pluginResult}
              />
            )}
            {message.pluginResult && (
              <PluginResultDisplay
                result={message.pluginResult}
                conversationId={conversationId}
                messageId={message.id}
                provider={provider}
                onPluginRun={onPluginRun}
                onPluginChat={onPluginChat}
                onPluginReloadCode={onPluginReloadCode}
                busy={busy}
                onStop={onStop}
              />
            )}
          </>
        )}

        <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {isUser && onEditUserMessage && (
            <button
              onClick={() => onEditUserMessage(conversationId, message.id, message.content, message.attachments)}
              className="text-xs text-gray-500 hover:text-white flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-700"
            >
              <Pencil size={12} /> 编辑
            </button>
          )}
          {!isUser && (
            <AssistantActions
              content={message.content}
              previousUserMessage={previousUserMessage}
              conversationId={conversationId}
              messageId={message.id}
              onResend={onResend}
              isError={isError}
              ttsAudioRef={ttsAudioRef}
              ttsPlaying={ttsPlaying}
              setTtsPlaying={setTtsPlaying}
              metrics={message.metrics}
              onLikeMessage={onLikeMessage}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 自动路由命中时，在 assistant 消息顶部展示一条小标签：
 *   🪄 意图: 代码编写/复杂  →  code_advanced · provider/model
 *   ↳ 已自动新建对话（话题切换）
 */
function AutoRouteBadge({ info }: { info: NonNullable<ChatMessage['autoRoute']> }) {
  const intentText = info.intent + (info.complexity ? `/${info.complexity}` : '');
  const trace = info.trace || [];
  const dot = (status?: string) =>
    status === 'error' ? 'bg-red-400' : status === 'warn' ? 'bg-amber-400' : 'bg-emerald-400';
  const summaryRow = (
    <div className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-900/30 border border-cyan-700/40 text-cyan-200">
        <Sparkles size={11} className="text-cyan-300" />
        意图: <span className="font-medium">{intentText}</span>
      </span>
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300">
        → 角色 <span className="font-mono text-cyan-300">{info.role}</span>
        {info.fallbackFrom && (
          <span className="text-amber-300" title={`原角色 ${info.fallbackFrom} 未配置，已回退到 chat_basic`}>
            ⤺{info.fallbackFrom}
          </span>
        )}
      </span>
      {(info.providerName || info.model) && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-400 font-mono">
          {info.providerName ? `${info.providerName} · ` : ''}{info.model || ''}
        </span>
      )}
      {info.sameTopic === false && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-900/30 border border-emerald-700/40 text-emerald-200" title="本次输入与上一次话题不同，已自动新建对话">
          🆕 新对话
        </span>
      )}
    </div>
  );

  // 无过程日志时退化为旧版单行徽章
  if (trace.length === 0) {
    return (
      <div className="mb-2">
        {summaryRow}
        {info.reason && (
          <span className="ml-1.5 text-[11px] text-gray-500" title={info.keywords?.length ? `关键词: ${info.keywords.join('、')}` : ''}>
            · {info.reason}
          </span>
        )}
      </div>
    );
  }

  return (
    <details open className="group mb-2 rounded-lg border border-cyan-800/30 bg-cyan-950/10">
      <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer list-none select-none">
        <ChevronRight size={13} className="text-cyan-400 shrink-0 transition-transform group-open:rotate-90" />
        <span className="text-[11px] text-cyan-300 font-medium shrink-0">意图分析</span>
        <div className="min-w-0 overflow-hidden">{summaryRow}</div>
      </summary>
      <div className="px-3 pb-2.5 pt-1 space-y-1.5">
        {trace.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px]">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot(t.status)}`} />
            <div className="min-w-0">
              <span className="text-gray-200">{t.step}</span>
              {typeof t.ms === 'number' && <span className="ml-1.5 text-gray-600">{t.ms}ms</span>}
              {t.detail && <div className="text-gray-400 break-words">{t.detail}</div>}
            </div>
          </div>
        ))}
        {info.keywords?.length ? (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {info.keywords.map((k, i) => (
              <span key={i} className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 text-[10px]">{k}</span>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 「讯息」检索研究工作流的过程面板：规划检索 → 联网搜索 → 抓取 → 整理。 */
function ResearchPanel({ info }: { info: NonNullable<ChatMessage['research']> }) {
  const steps = info.steps || [];
  if (steps.length === 0 && !(info.keywords?.length)) return null;
  const dot = (status?: string) =>
    status === 'error' ? 'bg-red-400' : status === 'warn' ? 'bg-amber-400' : 'bg-emerald-400';
  const running = steps.length > 0 && steps[steps.length - 1].step !== '完成' && steps[steps.length - 1].step !== '出错';
  return (
    <details open className="group mb-2 rounded-lg border border-sky-800/30 bg-sky-950/10">
      <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer list-none select-none">
        <ChevronRight size={13} className="text-sky-400 shrink-0 transition-transform group-open:rotate-90" />
        <Globe size={12} className="text-sky-300 shrink-0" />
        <span className="text-[11px] text-sky-300 font-medium">检索过程</span>
        {running && <Loader2 size={11} className="text-sky-400 animate-spin" />}
        {info.sites?.length ? (
          <span className="text-[10px] text-gray-500 truncate">· {info.sites.join(', ')}</span>
        ) : null}
      </summary>
      <div className="px-3 pb-2.5 pt-1 space-y-1.5">
        {steps.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-[11px]">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot(t.status)}`} />
            <div className="min-w-0">
              <span className="text-gray-200">{t.step}</span>
              {typeof t.ms === 'number' && <span className="ml-1.5 text-gray-600">{t.ms}ms</span>}
              {t.detail && <div className="text-gray-400 break-words">{t.detail}</div>}
            </div>
          </div>
        ))}
        {info.keywords?.length ? (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {info.keywords.map((k, i) => (
              <span key={i} className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 text-[10px]">{k}</span>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SourcesList({ sources }: { sources: NonNullable<ChatMessage['sources']> }) {
  const safe = sources.filter(s => s && s.url);
  if (!safe.length) return null;
  return (
    <details className="mt-3 border border-gray-700 rounded-lg bg-gray-800/30">
      <summary className="cursor-pointer px-3 py-2 text-xs text-gray-300 hover:text-white flex items-center gap-1.5 select-none">
        <Link2 size={12} className="text-cyan-400" />
        <span className="font-medium">引用 ({safe.length})</span>
        <span className="text-gray-500 ml-1">— 来自联网搜索的网页结果，点击可访问原文</span>
      </summary>
      <ol className="px-3 pb-3 pt-1 space-y-2 text-xs">
        {safe.map((s, i) => {
          let host = s.url;
          try { host = new URL(s.url).hostname; } catch {}
          return (
            <li key={i} className="border-l-2 border-cyan-500/50 pl-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-cyan-400 font-mono shrink-0">[{i + 1}]</span>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all"
                >
                  {s.title || s.url}
                </a>
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">{host}</div>
              {s.snippet && (
                <div className="text-gray-400 mt-1 leading-relaxed line-clamp-3">{s.snippet}</div>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// ============================================================
// PluginProgressTimeline
// ----
// 把 /api/chat-with-plugin/stream 推送过来的关键步骤
// （生成代码 / 创建插件 / 执行 / 修复 / ...）按时间线渲染到对话气泡里，
// 让用户能直观看到“插件模式”内部到底发生了什么。
// ============================================================
function PluginProgressTimeline({ events, inProgress }: { events: PluginProgressEvent[]; inProgress: boolean }) {
  const phaseMeta = {
    gen:      { label: '生成代码', Icon: Sparkle,     color: 'text-purple-300', dot: 'bg-purple-500/60' },
    validate: { label: '语法检查', Icon: CheckCircle2,color: 'text-cyan-300',   dot: 'bg-cyan-500/60' },
    create:   { label: '创建插件', Icon: FileCode2,   color: 'text-blue-300',   dot: 'bg-blue-500/60' },
    exec:     { label: '执行',     Icon: PlayCircle,  color: 'text-emerald-300',dot: 'bg-emerald-500/60' },
    fix:      { label: '修复',     Icon: Hammer,      color: 'text-amber-300',  dot: 'bg-amber-500/60' },
    error:    { label: '异常',     Icon: AlertTriangle,color:'text-red-300',    dot: 'bg-red-500/60' },
  } as const;

  const renderStatusIcon = (ev: PluginProgressEvent) => {
    if (ev.status === 'running') return <Loader size={12} className="animate-spin text-blue-400" />;
    if (ev.status === 'error')   return <XCircle size={12} className="text-red-400" />;
    if (ev.status === 'done' && ev.success === false) return <XCircle size={12} className="text-red-400" />;
    if (ev.status === 'done')    return <CheckCircle2 size={12} className="text-emerald-400" />;
    return <CheckCircle2 size={12} className="text-gray-400" />;
  };

  const formatTs = (ts?: number) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };

  // 把 status='output' 的行级日志按 (phase, attempt) 归并，挂到对应 running 步骤之下
  type OutputLine = { stream: 'stdout' | 'stderr'; text: string };
  const outputBuckets = new Map<string, OutputLine[]>();
  const visibleEvents: PluginProgressEvent[] = [];
  for (const ev of events) {
    if (ev.status === 'output') {
      const key = `${ev.phase}:${ev.attempt ?? 0}`;
      const bucket = outputBuckets.get(key) ?? [];
      bucket.push({
        stream: (ev.stream === 'stderr' ? 'stderr' : 'stdout'),
        text: ev.text ?? '',
      });
      outputBuckets.set(key, bucket);
    } else {
      visibleEvents.push(ev);
    }
  }

  const total = visibleEvents.length;
  const lastErrored = visibleEvents.length > 0 && visibleEvents[visibleEvents.length - 1].status === 'error';
  const headerLabel = inProgress
    ? `运行过程（共 ${total} 步，进行中…）`
    : (lastErrored ? `运行过程（共 ${total} 步，已结束 / 失败）` : `运行过程（共 ${total} 步，已完成）`);

  return (
    <details className="mt-3 border border-gray-700 rounded-lg bg-gray-800/30" open={inProgress}>
      <summary className="cursor-pointer px-3 py-2 text-xs text-gray-300 hover:text-white flex items-center gap-1.5 select-none">
        {inProgress
          ? <Loader size={12} className="animate-spin text-blue-400" />
          : (lastErrored ? <XCircle size={12} className="text-red-400" /> : <CheckCircle2 size={12} className="text-emerald-400" />)
        }
        <span className="font-medium">{headerLabel}</span>
      </summary>
      <ol className="px-3 pb-3 pt-1 space-y-2 text-xs">
        {visibleEvents.map((ev, i) => {
          const meta = phaseMeta[ev.phase] ?? phaseMeta.error;
          const Icon = meta.Icon;
          const hasCode = !!(ev.code_preview && ev.code_preview.length > 0);
          const hasFailure = !!(ev.failure_preview && ev.failure_preview.length > 0);
          // exec/fix 阶段的 running 行下方挂"实时控制台"
          const consoleKey = `${ev.phase}:${ev.attempt ?? 0}`;
          const consoleLines = (ev.phase === 'exec' || ev.phase === 'fix') && ev.status === 'running'
            ? (outputBuckets.get(consoleKey) ?? [])
            : [];
          // 同一 attempt 在 running -> done/error 之后，仍把日志附在 done/error 行上
          const consoleLinesOnFinal = (ev.phase === 'exec' || ev.phase === 'fix') && (ev.status === 'done' || ev.status === 'error')
            ? (outputBuckets.get(consoleKey) ?? [])
            : [];
          // 防止同一组日志被 running + done 同时展示：只在 running 行还出现在时间线时挂 running 那行；
          // 一旦本 attempt 出现了终态，optionally 展示在终态行（默认折叠）。
          const hasAnyRunningInBucket = visibleEvents.some(
            (e2) => e2.phase === ev.phase && e2.attempt === ev.attempt && e2.status === 'running'
          );
          return (
            <li key={i} className="relative pl-5">
              <span className={`absolute left-1 top-1.5 inline-block w-2 h-2 rounded-full ${meta.dot}`} />
              <div className="flex items-center flex-wrap gap-1.5">
                <Icon size={12} className={meta.color} />
                <span className={`font-mono uppercase tracking-wide text-[10px] ${meta.color}`}>{meta.label}</span>
                {ev.attempt && (
                  <span className="text-gray-500 font-mono text-[10px]">#{ev.attempt}</span>
                )}
                {ev.language && (
                  <span className="px-1 py-px rounded bg-gray-700/60 text-gray-300 text-[10px] font-mono uppercase">
                    {ev.language}
                  </span>
                )}
                {renderStatusIcon(ev)}
                <span className="text-gray-200 leading-relaxed break-words">{ev.message}</span>
                {ev.ts != null && (
                  <span className="text-gray-500 font-mono text-[10px] ml-auto">{formatTs(ev.ts)}</span>
                )}
              </div>
              {consoleLines.length > 0 && (
                <LiveConsole lines={consoleLines} autoFollow />
              )}
              {consoleLinesOnFinal.length > 0 && !hasAnyRunningInBucket && (
                <LiveConsole lines={consoleLinesOnFinal} autoFollow={false} />
              )}
              {ev.files && ev.files.length > 0 && (
                <details className="mt-1 ml-1" open>
                  <summary className="cursor-pointer text-[11px] text-blue-300/80 hover:text-blue-200 select-none">
                    项目文件清单（{ev.files.length} 个）
                  </summary>
                  <ul className="mt-1 px-2 py-1.5 bg-gray-900/70 border border-gray-700/60 rounded text-[11px] text-gray-300 font-mono space-y-0.5">
                    {ev.files.map(f => (
                      <li key={f.path} className="flex items-center gap-2">
                        <FileCode2 size={11} className="text-blue-300/60" />
                        <span>{f.path}</span>
                        {f.language && <span className="text-gray-500">[{f.language}]</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {ev.validation_error && (
                <details className="mt-1 ml-1" open={ev.status === 'error'}>
                  <summary className="cursor-pointer text-[11px] text-cyan-300/80 hover:text-cyan-200 select-none">
                    语法检查报告
                  </summary>
                  <pre className="mt-1 px-2 py-1.5 bg-cyan-950/30 border border-cyan-900/40 rounded text-[11px] text-cyan-200 font-mono overflow-x-auto whitespace-pre-wrap">
{ev.validation_error}
                  </pre>
                </details>
              )}
              {hasCode && (
                <details className="mt-1 ml-1">
                  <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-200 select-none">
                    代码预览 {ev.code_lines ? `(${ev.code_lines} 行)` : ''}
                  </summary>
                  <pre className="mt-1 px-2 py-1.5 bg-gray-900/70 border border-gray-700/60 rounded text-[11px] text-gray-300 font-mono overflow-x-auto whitespace-pre">
{ev.code_preview}
                  </pre>
                </details>
              )}
              {hasFailure && (
                <details className="mt-1 ml-1">
                  <summary className="cursor-pointer text-[11px] text-red-300/80 hover:text-red-200 select-none">
                    失败日志摘要
                  </summary>
                  <pre className="mt-1 px-2 py-1.5 bg-red-950/40 border border-red-900/40 rounded text-[11px] text-red-200 font-mono overflow-x-auto whitespace-pre-wrap">
{ev.failure_preview}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// ============================================================
// LiveConsole — 把插件子进程的 stdout/stderr 行级输出实时滚动展示
// stderr 行用红色，stdout 行用浅灰；autoFollow 为 true 时自动跟踪滚到底
// ============================================================
function LiveConsole({ lines, autoFollow = true }: { lines: { stream: 'stdout' | 'stderr'; text: string }[]; autoFollow?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoFollow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, autoFollow]);
  return (
    <div
      ref={containerRef}
      className="mt-1 ml-1 px-2 py-1.5 bg-gray-950/80 border border-gray-700/70 rounded text-[11px] text-gray-200 font-mono overflow-auto max-h-48"
    >
      {lines.map((ln, idx) => (
        <div key={idx} className={ln.stream === 'stderr' ? 'text-red-300 whitespace-pre-wrap break-words' : 'text-gray-300 whitespace-pre-wrap break-words'}>
          {ln.text.replace(/\n$/, '')}
        </div>
      ))}
      {lines.length === 0 && (
        <div className="text-gray-500 italic">（等待子进程输出...）</div>
      )}
    </div>
  );
}
