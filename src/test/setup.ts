import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { webcrypto } from 'node:crypto';

vi.stubGlobal('crypto', webcrypto);
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
Object.defineProperty(window,'matchMedia',{writable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})});
Element.prototype.scrollIntoView=()=>{};
class OfflineSocket extends EventTarget {
  static OPEN=1; static CLOSED=3; static CONNECTING=0;
  readyState=0; onopen=null; onmessage=null; onclose=null; onerror=null;
  send() {} close() {this.readyState=3;}
}
vi.stubGlobal('WebSocket',OfflineSocket);
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();delete window.desktop;});
