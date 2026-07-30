import type { RichContent, RichContentItem } from '../types';

function containsHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

function SafeHtml({ content, className }: { content: string; className?: string }) {
  if (containsHtml(content)) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: content }} />;
  }
  return <span className={className}>{content}</span>;
}

function ContentItemRenderer({ item }: { item: RichContentItem }) {
  switch (item.type) {
    case 'text':
      const textData = typeof item.data === 'string' ? item.data : String(item.data ?? '');
      if (containsHtml(textData)) {
        return <div className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: textData }} />;
      }
      return <div className="whitespace-pre-wrap text-gray-200">{textData}</div>;
    case 'status':
      const statusStyles: Record<string, string> = {
        success: 'border-green-500 text-green-300 bg-green-900/20',
        warning: 'border-amber-500 text-amber-300 bg-amber-900/20',
        error: 'border-red-500 text-red-300 bg-red-900/20',
        info: 'border-blue-500 text-blue-300 bg-blue-900/20',
      };
      const statusIcons: Record<string, string> = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };
      const st = item.status || 'info';
      return (
        <div className={`p-3 rounded-lg border-l-4 ${statusStyles[st] || statusStyles.info}`}>
          <span className="mr-2">{statusIcons[st]}</span>
          <SafeHtml content={item.message || ''} />
        </div>
      );
    case 'list':
      return (
        <div className="bg-gray-800/50 rounded-lg p-4">
          {item.title && <h4 className="font-semibold mb-2 text-gray-300">{item.title}</h4>}
          <ul className="space-y-2">
            {item.items?.map((li, i) => (
              <li key={i} className="text-gray-400 flex items-start gap-2">
                <span className="text-gray-500 mt-1">•</span>
                <SafeHtml content={li} className="flex-1" />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'table':
      return (
        <div className="overflow-x-auto">
          {item.title && <h4 className="font-semibold mb-2 text-gray-300">{item.title}</h4>}
          <table className="min-w-full border border-gray-600 rounded-lg overflow-hidden">
            <thead className="bg-gray-700">
              <tr>
                {item.headers?.map((h, i) => (
                  <th key={i} className="px-4 py-2 text-left font-medium text-gray-300 border-b border-gray-600">
                    <SafeHtml content={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {item.rows?.map((row, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-gray-800/50' : 'bg-gray-800/30'}>
                  {row.map((cell, j) => (
                    <td key={j} className="px-4 py-2 border-b border-gray-700 text-gray-400">
                      <SafeHtml content={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return (
        <div className="bg-gray-900 rounded-lg overflow-hidden">
          {item.language && (
            <div className="bg-gray-800 px-4 py-2 text-gray-400 text-sm">{item.language}</div>
          )}
          <pre className="p-4 overflow-x-auto">
            <code className="text-green-400 text-sm">{typeof item.data === 'string' ? item.data : ''}</code>
          </pre>
        </div>
      );
    case 'image':
      const imgData = item.data;
      if (typeof imgData === 'string' && imgData.startsWith('<img')) {
        return (
          <div className="flex flex-col items-center">
            <div dangerouslySetInnerHTML={{ __html: imgData }} />
          </div>
        );
      }
      const src = typeof imgData === 'string' && (imgData.startsWith('data:') || imgData.startsWith('http'))
        ? imgData
        : imgData
          ? `data:image/png;base64,${imgData}`
          : '';
      if (!src) return null;
      return (
        <div className="flex flex-col items-center">
          <img src={src} alt={typeof item.data === 'object' && item.data && 'alt' in item.data ? String((item.data as { alt?: string }).alt) : '图片'} className="max-w-full rounded-lg" />
        </div>
      );
    case 'info':
      return (
        <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-600">
          {item.title && <h4 className="font-semibold mb-2 text-gray-300">{item.title}</h4>}
          {item.data && typeof item.data === 'object' && (
            <div className="space-y-2">
              {Object.entries(item.data as Record<string, unknown>).map(([k, v]) => (
                <div key={k} className="flex items-start gap-2">
                  <span className="font-medium text-gray-400">{k}:</span>
                  <span className="text-gray-300">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    default:
      return <div className="whitespace-pre-wrap text-gray-400">{JSON.stringify(item.data)}</div>;
  }
}

export default function RichContentRenderer({ content }: { content: RichContent }) {
  if (!content) return null;
  if (content.type === 'text') {
    const text = typeof content.content === 'string' ? content.content : (content as unknown as { data?: string }).data;
    return <div className="whitespace-pre-wrap text-gray-200">{text ?? ''}</div>;
  }
  if (content.type === 'mixed' && Array.isArray(content.content)) {
    return (
      <div className="space-y-4">
        {content.content.map((item, i) => (
          <ContentItemRenderer key={i} item={item as RichContentItem} />
        ))}
      </div>
    );
  }
  return <ContentItemRenderer item={content as unknown as RichContentItem} />;
}
