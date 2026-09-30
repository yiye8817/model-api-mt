"""Optional X11 desktop automation with explicit observations and PyAutoGUI failsafe."""
from __future__ import annotations

import csv
import io
import math
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from .contracts import ToolError, ToolSpec


def _schema(properties=None, required=()):
    return {'type': 'object', 'properties': properties or {}, 'required': list(required), 'additionalProperties': False}


class DesktopTools:
    def __init__(self, runtime_dir: Path, observation_ttl=180):
        self.runtime_dir = Path(runtime_dir)
        if type(observation_ttl) not in (int, float) or not math.isfinite(observation_ttl) or observation_ttl <= 0:
            raise ValueError('observation_ttl must be a finite positive number of seconds')
        self.observation_ttl = observation_ttl
        self._gui = None
        self._observation = None
        self._observed_at = 0.0
        self._size = None

    def specs(self):
        obs = {'observation_id': {'type': 'string', 'description': f'Use the latest desktop.observe id; expires after {self.observation_ttl:g} seconds or one action.'}}
        xy = {**obs, 'x': {'type': 'integer', 'minimum': 0}, 'y': {'type': 'integer', 'minimum': 0}}
        expected = {'text_contains': {'type': 'string', 'minLength': 1, 'maxLength': 8000,
                                      'description': 'Case-sensitive text expected in fresh OCR, with whitespace normalized.'},
                    'x': {'type': 'integer', 'minimum': 0}, 'y': {'type': 'integer', 'minimum': 0}}
        def spec(name, description, properties, required, handler, mutating=True):
            return ToolSpec('desktop.' + name, description, _schema(properties, required), 'desktop', mutating, handler)
        verify_schema = _schema(expected)
        verify_schema['anyOf'] = [_schema({'text_contains': expected['text_contains']}, ('text_contains',)),
                                  _schema(expected, ('x', 'y'))]
        return [
            spec('observe', 'Capture the primary X11 screen locally and read optional Tesseract OCR. The text-only model cannot see the screenshot.', {}, (), self.observe, False),
            ToolSpec('desktop.verify', 'Check concrete expected text against fresh screenshot OCR and/or current pointer coordinates. Supply text_contains and/or paired x/y; all expectations must match. A screenshot alone cannot verify a result.', verify_schema, 'desktop', False, self.verify),
            spec('click', 'Click coordinates from current OCR or explicitly provided by the user; never guess unseen controls.', {**xy, 'button': {'type': 'string', 'enum': ['left', 'middle', 'right']}, 'clicks': {'type': 'integer', 'minimum': 1, 'maximum': 2}}, ('observation_id', 'x', 'y'), self.click),
            spec('move', 'Move to coordinates from a current observation.', xy, ('observation_id', 'x', 'y'), self.move),
            spec('drag', 'Drag from current pointer to observed target coordinates.', {**xy, 'duration': {'type': 'number', 'minimum': 0.1, 'maximum': 5}}, ('observation_id', 'x', 'y'), self.drag),
            spec('scroll', 'Scroll at the current pointer location; observe again afterwards.', {**obs, 'clicks': {'type': 'integer', 'minimum': -50, 'maximum': 50}}, ('observation_id', 'clicks'), self.scroll),
            spec('hotkey', 'Press a key/chord, e.g. ["ctrl","l"] or ["enter"].', {**obs, 'keys': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 5}}, ('observation_id', 'keys'), self.hotkey),
            spec('type', 'Type into the focused control. Unicode uses optional clipboard support. Do not pass passwords.', {**obs, 'text': {'type': 'string', 'maxLength': 8000}}, ('observation_id', 'text'), self.type_text),
        ]

    def _start(self):
        # An XWayland DISPLAY does not grant access to the native Wayland desktop.
        if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland':
            raise ToolError('wayland_unsupported', 'Full desktop control is unavailable in a Wayland session. Use the browser tools, or log into an X11 session yourself. System security settings are not changed.', not_executed=True)
        if not os.environ.get('DISPLAY'):
            raise ToolError('display_unavailable', 'No X11 DISPLAY is available. Start this agent inside your local X11 desktop session.', not_executed=True)
        if self._gui is None:
            try:
                import pyautogui
                self._gui = pyautogui
            except ImportError as exc:
                raise ToolError('dependency_missing', 'Install optional desktop dependencies (PyAutoGUI, Pillow; pyperclip for Unicode input).', not_executed=True) from None
            except Exception as exc:
                raise ToolError('display_unavailable', 'Cannot access the X11 desktop. Check the local desktop session and DISPLAY access.', not_executed=True) from None
        self._gui.FAILSAFE = True
        self._gui.PAUSE = 0.15
        return self._gui

    def _call(self, action):
        gui = self._start()
        try:
            return action(gui)
        except ToolError:
            raise
        except gui.FailSafeException as exc:
            self._invalidate()
            raise ToolError('desktop_failsafe', 'PyAutoGUI emergency stop was triggered. Desktop actions have stopped; move the pointer away from a screen corner and explicitly restart the task.') from None
        except Exception as exc:
            raise ToolError('desktop_action_failed', 'Desktop action failed. It was not retried. Observe the desktop before deciding whether to retry.') from None

    def _invalidate(self):
        self._observation = self._size = None
        self._observed_at = 0.0

    def _ocr(self, path):
        executable = shutil.which('tesseract')
        if not executable:
            return {'available': False, 'elements': [], 'reason': 'Tesseract is not installed. The model cannot infer screen contents from the saved screenshot; use browser DOM tools or user-provided coordinates.'}
        try:
            languages = subprocess.run([executable, '--list-langs'], capture_output=True, text=True, timeout=5, check=True).stdout.splitlines()
            chosen = [lang for lang in ('eng', 'chi_sim', 'chi_tra') if lang in languages]
            if not chosen:
                return {'available': False, 'elements': [], 'reason': 'No supported OCR language pack is installed (eng or chi_sim/chi_tra).'}
            result = subprocess.run([executable, str(path), 'stdout', '-l', '+'.join(chosen), 'tsv'], capture_output=True, text=True, timeout=15, check=True)
            rows = []
            for row in csv.DictReader(io.StringIO(result.stdout[:1_000_000]), delimiter='\t'):
                text = (row.get('text') or '').strip()
                if not text:
                    continue
                try:
                    confidence = float(row['conf'])
                    x, y, width, height = (int(row[key]) for key in ('left', 'top', 'width', 'height'))
                except (KeyError, TypeError, ValueError):
                    continue
                if confidence < 30 or min(x, y, width, height) < 0:
                    continue
                rows.append({'text': text[:300], 'x': x, 'y': y, 'width': width, 'height': height, 'confidence': confidence})
                if len(rows) >= 1000:
                    break
            return {'available': True, 'languages': chosen, 'elements': rows, 'notice': 'OCR is approximate text, not visual understanding. Use the center of an identified bounding box; never guess an unseen control.'}
        except (subprocess.SubprocessError, OSError, UnicodeError):
            return {'available': False, 'elements': [], 'reason': 'OCR failed or timed out. The screenshot remains local; the model cannot see its pixels.'}

    def observe(self, args):
        self._invalidate()
        artifacts = self.runtime_dir / 'artifacts'
        artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = artifacts / ('desktop-' + uuid.uuid4().hex + '.png')
        def capture(gui):
            size = tuple(gui.size())
            gui.screenshot().save(str(path))
            path.chmod(0o600)
            return size
        width, height = self._call(capture)
        captured_at = time.monotonic()
        ocr = self._ocr(path)
        self._size = (width, height)
        self._observation = uuid.uuid4().hex
        self._observed_at = captured_at
        return {'observation_id': self._observation, 'screen': {'width': width, 'height': height, 'scope': 'primary X11 screen'},
                'screenshot_path': str(path.resolve()), 'model_can_see_image': False, 'ocr': ocr,
                'observation_ttl_seconds': self.observation_ttl,
                'notice': f'Use only observed OCR coordinates or coordinates explicitly given by the user. Observation expires in {self.observation_ttl:g} seconds; any action requires a new observation.'}

    def _fresh(self, args):
        gui = self._start()
        if not self._observation or args.get('observation_id') != self._observation or time.monotonic() - self._observed_at > self.observation_ttl:
            raise ToolError('stale_observation', 'Obtain a new desktop.observe before acting.', not_executed=True)
        try:
            size = self._call(lambda g: tuple(g.size()))
        except ToolError as exc:
            # This is an observation-only preflight. No input action has reached
            # PyAutoGUI yet, even when querying the screen fails.
            exc.not_executed = True
            raise
        if size != self._size:
            self._invalidate()
            raise ToolError('screen_changed', 'Screen dimensions changed. Obtain a new desktop.observe.', not_executed=True)
        return gui

    def verify(self, args):
        if not isinstance(args, dict) or not args or set(args) - {'text_contains', 'x', 'y'}:
            raise ToolError('invalid_argument', 'Provide only text_contains and/or paired x/y coordinates to verify.', not_executed=True)
        has_text = 'text_contains' in args
        has_pointer = 'x' in args or 'y' in args
        if not has_text and not has_pointer:
            raise ToolError('invalid_argument', 'Provide text_contains and/or paired x/y coordinates to verify.', not_executed=True)
        if has_text and (not isinstance(args['text_contains'], str) or not args['text_contains'].strip()
                         or len(args['text_contains']) > 8000):
            raise ToolError('invalid_argument', 'text_contains must be nonempty text no longer than 8000 characters.', not_executed=True)
        if has_pointer and any(type(args.get(key)) is not int or args[key] < 0 for key in ('x', 'y')):
            raise ToolError('invalid_argument', 'Provide both x and y as nonnegative integer pixels.', not_executed=True)

        method = 'ocr_assertions' if has_text else 'pointer_position'
        result = {'checks': {},
                  'notice': 'Verification covers only the supplied assertions. A pointer-position match confirms the pointer position; it does not establish an application action succeeded.'}
        failures = []
        unavailable = False
        if has_text:
            observation = self.observe({})
            result['observation'] = observation
            ocr = observation['ocr']
            expected_text = ' '.join(args['text_contains'].split())
            observed_text = ' '.join(' '.join(row['text'] for row in ocr['elements']).split())
            matched = ocr['available'] is True and expected_text in observed_text
            result['checks']['text_contains'] = {'expected': expected_text, 'matched': matched,
                                                  'ocr_available': ocr['available'] is True}
            if not matched:
                unavailable = ocr['available'] is not True
                failures.append('OCR is unavailable for the expected text.' if unavailable
                                else 'Fresh OCR did not contain the expected text.')
        if has_pointer:
            x, y = self._call(lambda gui: tuple(gui.position()))
            matched = (x, y) == (args['x'], args['y'])
            result['checks']['pointer'] = {'expected': {'x': args['x'], 'y': args['y']},
                                           'actual': {'x': x, 'y': y}, 'matched': matched}
            if not matched:
                failures.append('The current pointer position did not match the expected coordinates.')
        result['ok'] = not failures
        result['verification'] = {'status': 'failed' if failures else 'verified', 'method': method, 'scope': 'desktop'}
        if failures:
            result['error'] = {'code': 'ocr_unavailable' if unavailable else 'verification_failed',
                               'message': ' '.join(failures)}
        return result

    def _xy(self, args):
        self._fresh(args)
        x, y = args.get('x'), args.get('y')
        if any(not isinstance(v, int) or isinstance(v, bool) for v in (x, y)) or not (0 <= x < self._size[0] and 0 <= y < self._size[1]):
            raise ToolError('invalid_coordinates', 'Coordinates must be integer pixels inside the observed primary screen.', not_executed=True)
        return x, y

    def _perform(self, args, action):
        self._fresh(args)
        try:
            self._call(action)
            return {'performed': True, 'observation_required': True,
                    'verification': {'status': 'pending', 'method': 'postcondition_required', 'scope': 'desktop'}}
        finally:
            self._invalidate()

    def click(self, args):
        x, y = self._xy(args)
        button, clicks = args.get('button', 'left'), args.get('clicks', 1)
        if button not in ('left', 'middle', 'right') or type(clicks) is not int or clicks not in (1, 2):
            raise ToolError('invalid_argument', 'Use left/middle/right and one or two clicks.', not_executed=True)
        return self._perform(args, lambda gui: gui.click(x=x, y=y, button=button, clicks=clicks, interval=0.12))

    def move(self, args):
        x, y = self._xy(args)
        return self._perform(args, lambda gui: gui.moveTo(x, y, duration=0.2))

    def drag(self, args):
        x, y = self._xy(args)
        duration = args.get('duration', 0.5)
        if type(duration) not in (int, float) or not 0.1 <= duration <= 5:
            raise ToolError('invalid_argument', 'Drag duration must be between 0.1 and 5 seconds.', not_executed=True)
        return self._perform(args, lambda gui: gui.dragTo(x, y, duration=duration, button='left'))

    def scroll(self, args):
        clicks = args.get('clicks')
        if type(clicks) is not int or not -50 <= clicks <= 50:
            raise ToolError('invalid_argument', 'Scroll clicks must be an integer within -50..50.', not_executed=True)
        return self._perform(args, lambda gui: gui.scroll(clicks))

    def hotkey(self, args):
        gui = self._fresh(args)
        keys = args.get('keys')
        if not isinstance(keys, list) or not 1 <= len(keys) <= 5 or any(not isinstance(k, str) or k.lower() not in gui.KEYBOARD_KEYS for k in keys):
            raise ToolError('invalid_argument', 'Provide one to five valid PyAutoGUI key names, such as ctrl, l, or enter.', not_executed=True)
        return self._perform(args, lambda g: g.hotkey(*(k.lower() for k in keys)))

    def type_text(self, args):
        self._fresh(args)
        text = args.get('text')
        if not isinstance(text, str) or len(text) > 8000:
            raise ToolError('invalid_argument', 'Text must be a string no longer than 8000 characters.', not_executed=True)
        if text.isascii():
            return self._perform(args, lambda gui: gui.write(text, interval=0.005))
        try:
            import pyperclip
        except ImportError as exc:
            raise ToolError('clipboard_dependency_missing', 'Unicode input requires pyperclip and a working X11 clipboard provider (xclip or xsel). No text was typed.', not_executed=True) from None
        try:
            previous = pyperclip.paste()
        except Exception:
            raise ToolError('clipboard_unavailable', 'Cannot read the X11 clipboard for Unicode input. Install/configure xclip or xsel. No text was typed.', not_executed=True) from None
        try:
            pyperclip.copy(text)
        except Exception as exc:
            raise ToolError('clipboard_unavailable', 'Cannot access the X11 clipboard for Unicode input. Install/configure xclip or xsel. No text was typed.') from None
        try:
            result = self._perform(args, lambda gui: gui.hotkey('ctrl', 'v'))
            time.sleep(0.3)
        finally:
            try:
                pyperclip.copy(previous)
            except Exception:
                # Do not mask an emergency stop or earlier failure if restoration fails.
                pass
        return {**result, 'input_method': 'clipboard', 'notice': 'Paste was issued once; verify the target control accepted the Unicode text.'}

    def close(self):
        self._invalidate()
        self._gui = None
