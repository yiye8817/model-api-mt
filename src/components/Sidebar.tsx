import { useState } from 'react';
import {
  Plus, Settings, MessageSquare, Trash2, Edit2,
  ChevronDown, Server, PanelLeftClose, PanelLeft,
  Terminal, ExternalLink, RefreshCw, Loader2, Cpu,
} from 'lucide-react';
import type { APIProvider, Conversation } from '../types';

interface Props {
  providers: APIProvider[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activeProviderId: string | null;
  collapsed: boolean;
  terminalVisible: boolean;
  onToggleCollapse: () => void;
  onToggleTerminal: () => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onOpenConfig: (provider?: APIProvider) => void;
  onDeleteProvider: (id: string) => void;
  onSelectProvider: (id: string) => void;
  onSelectModel: (providerId: string, model: string) => void;
  onRefreshProviderModels?: (providerId: string) => Promise<void> | void;
  onAddLocalProvider?: (port: string, host?: string) => Promise<void> | void;
  onOpenLocalHub?: () => void;
}

export default function Sidebar({
  providers,
  conversations,
  activeConversationId,
  activeProviderId,
  collapsed,
  terminalVisible,
  onToggleCollapse,
  onToggleTerminal,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  onOpenConfig,
  onDeleteProvider,
  onSelectProvider,
  onSelectModel,
  onRefreshProviderModels,
  onAddLocalProvider,
  onOpenLocalHub,
}: Props) {
  const [showProviders, setShowProviders] = useState(true);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [addingLocal, setAddingLocal] = useState(false);

  const handleClickLocal = async () => {
    // 优先打开本地模型 Hub（管理 llama-server / 下载 / API 文档）；
    // 若未挂载，则降级为旧的"快速添加 OpenAI 兼容 provider"
    if (onOpenLocalHub) { onOpenLocalHub(); return; }
    if (!onAddLocalProvider || addingLocal) return;
    const input = window.prompt(
      '输入 LLM 服务地址：\n  本机：直接填端口（如 8080）\n  远端：host:port（如 192.168.1.10:8080）',
      '8080',
    );
    if (input == null) return;
    const trimmed = input.trim();
    let host = '127.0.0.1';
    let port = '8080';
    if (trimmed.includes(':')) {
      const [h, p] = trimmed.split(':');
      host = h.trim() || '127.0.0.1';
      port = p.trim() || '8080';
    } else {
      port = trimmed || '8080';
    }
    setAddingLocal(true);
    try {
      await onAddLocalProvider(port, host);
    } finally {
      setAddingLocal(false);
    }
  };

  const handleRefreshClick = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!onRefreshProviderModels || refreshingId) return;
    setRefreshingId(id);
    try {
      await onRefreshProviderModels(id);
    } finally {
      setRefreshingId(null);
    }
  };

  if (collapsed) {
    return (
      <div className="w-14 bg-gray-900 border-r border-gray-700 flex flex-col items-center py-4 gap-3 shrink-0">
        <button onClick={onToggleCollapse} className="text-gray-400 hover:text-white p-2">
          <PanelLeft size={20} />
        </button>
        <button onClick={onNewConversation} className="text-gray-400 hover:text-white p-2 bg-gray-800 rounded-lg">
          <Plus size={20} />
        </button>
        <button onClick={() => onOpenConfig()} className="text-gray-400 hover:text-white p-2">
          <Settings size={20} />
        </button>
        <div className="flex-1" />
        <button
          onClick={onToggleTerminal}
          className={`p-2 rounded-lg transition-colors ${
            terminalVisible ? 'text-green-400 bg-green-400/10' : 'text-gray-400 hover:text-white'
          }`}
          title="Toggle Terminal"
        >
          <Terminal size={20} />
        </button>
      </div>
    );
  }

  const activeProvider = providers.find(p => p.id === activeProviderId);

  return (
    <div className="w-72 bg-gray-900 border-r border-gray-700 flex flex-col shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-gray-700 flex items-center justify-between">
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Server size={20} className="text-blue-400" />
          LLM Manager
        </h1>
        <button onClick={onToggleCollapse} className="text-gray-400 hover:text-white">
          <PanelLeftClose size={20} />
        </button>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={onNewConversation}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-medium transition-colors"
        >
          <Plus size={18} />
          New Chat
        </button>
      </div>

      {/* Provider Selector */}
      <div className="px-3 pb-3">
        <button
          onClick={() => setShowProviders(!showProviders)}
          className="w-full flex items-center justify-between text-sm text-gray-400 hover:text-white py-1.5 transition-colors"
        >
          <span className="font-medium uppercase tracking-wider text-xs">API Providers</span>
          <ChevronDown size={14} className={`transition-transform ${showProviders ? 'rotate-180' : ''}`} />
        </button>

        {showProviders && (
          <div className="mt-2 flex flex-col min-h-0">
            <div className="max-h-56 overflow-y-auto space-y-1 pr-0.5 scrollbar-thin">
              {providers.map(p => (
                <div
                  key={p.id}
                  className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    activeProviderId === p.id
                      ? 'bg-blue-600/20 border border-blue-500/30 text-blue-300'
                      : 'hover:bg-gray-800 text-gray-300'
                  }`}
                  onClick={() => onSelectProvider(p.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs text-gray-500 truncate font-mono">{p.selectedModel || 'No model'}</div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {p.source?.trim() && (
                      <button
                        onClick={e => { e.stopPropagation(); window.open(p.source!.trim(), '_blank'); }}
                        className="p-1 hover:text-amber-400"
                        title="打开 Provider 来源"
                      >
                        <ExternalLink size={13} />
                      </button>
                    )}
                    {onRefreshProviderModels && (
                      <button
                        onClick={e => handleRefreshClick(e, p.id)}
                        disabled={refreshingId === p.id}
                        className="p-1 hover:text-cyan-400 disabled:opacity-60 disabled:cursor-not-allowed"
                        title="刷新此 Provider 的模型列表"
                      >
                        {refreshingId === p.id
                          ? <Loader2 size={13} className="animate-spin" />
                          : <RefreshCw size={13} />}
                      </button>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onOpenConfig(p); }}
                      className="p-1 hover:text-blue-400"
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteProvider(p.id); }}
                      className="p-1 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1 mt-1 shrink-0">
              <button
                onClick={() => onOpenConfig()}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-blue-400 hover:bg-gray-800 rounded-lg transition-colors"
              >
                <Plus size={14} />
                Add Provider
              </button>
              {(onOpenLocalHub || onAddLocalProvider) && (
                <button
                  onClick={handleClickLocal}
                  disabled={addingLocal}
                  title={onOpenLocalHub
                    ? '打开本地模型 Hub：管理 llama-server / 下载 GGUF / API 文档'
                    : '一键添加本地 LLM (llama-server / Ollama / LM Studio)'}
                  className="flex items-center gap-1 px-2 py-2 text-sm text-gray-500 hover:text-emerald-300 hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
                >
                  {addingLocal ? <Loader2 size={14} className="animate-spin" /> : <Cpu size={14} />}
                  <span className="text-xs">本地</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Model selector for active provider */}
        {activeProvider && activeProvider.models.length > 0 && (
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">Model</label>
            <select
              value={activeProvider.selectedModel}
              onChange={e => onSelectModel(activeProvider.id, e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {activeProvider.models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 border-t border-gray-800 pt-3">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2 px-1">Conversations</div>
        {conversations.length === 0 ? (
          <p className="text-sm text-gray-600 px-1">No conversations yet</p>
        ) : (
          <div className="space-y-0.5">
            {conversations.map(conv => (
              <div
                key={conv.id}
                className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                  activeConversationId === conv.id
                    ? 'bg-gray-700/70 text-white'
                    : 'hover:bg-gray-800 text-gray-300'
                }`}
                onClick={() => onSelectConversation(conv.id)}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <MessageSquare size={14} className="shrink-0 text-gray-500" />
                  <span className="text-sm truncate">{conv.title}</span>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                  className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Terminal Toggle - Bottom */}
      <div className="p-3 border-t border-gray-800">
        <button
          onClick={onToggleTerminal}
          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium transition-colors text-sm ${
            terminalVisible
              ? 'bg-green-600/20 text-green-400 border border-green-500/30 hover:bg-green-600/30'
              : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
          }`}
        >
          <Terminal size={16} />
          {terminalVisible ? 'Hide Terminal' : 'Open Terminal'}
        </button>
      </div>
    </div>
  );
}
