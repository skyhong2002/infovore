import type { DayflowBatch, DayflowKeyword } from './types.js';

// Publish recognizable tool/project/topic labels, not arbitrary tokens from
// screen-derived prose. Matching is local; no activity text is sent to an LLM.
const vocabulary: Array<[string, string[]]> = [
  ['infovore', ['infovore']], ['urtube', ['urtube']], ['Dayflow', ['dayflow']],
  ['Claude', ['claude']], ['Codex', ['codex']], ['ChatGPT', ['chatgpt']],
  ['Gemini', ['gemini']], ['OpenAI', ['openai']], ['Ollama', ['ollama']],
  ['GitHub', ['github']], ['GitLab', ['gitlab']], ['Git', ['git']],
  ['VS Code', ['vs code', 'vscode', 'visual studio code']], ['Cursor', ['cursor']],
  ['TypeScript', ['typescript']], ['JavaScript', ['javascript']], ['Python', ['python']],
  ['Swift', ['swift', 'swiftui']], ['Kotlin', ['kotlin']], ['Rust', ['rust']],
  ['React', ['react', 'reactjs']], ['Next.js', ['next.js', 'nextjs']],
  ['Node.js', ['node.js', 'nodejs']], ['Hono', ['hono']], ['Svelte', ['svelte']],
  ['SQLite', ['sqlite']], ['PostgreSQL', ['postgresql', 'postgres']], ['Redis', ['redis']],
  ['Docker', ['docker']], ['Kubernetes', ['kubernetes', 'k8s']],
  ['Cloudflare', ['cloudflare']], ['Vercel', ['vercel']], ['AWS', ['aws']],
  ['Google Cloud', ['google cloud', 'gcp']], ['Firebase', ['firebase']],
  ['Supabase', ['supabase']], ['Dokploy', ['dokploy']], ['Traefik', ['traefik']],
  ['Tailscale', ['tailscale']], ['Linux', ['linux']], ['macOS', ['macos']],
  ['Android', ['android']], ['iOS', ['ios']],
  ['MCP', ['mcp', 'model context protocol']], ['OAuth', ['oauth', 'oauth2']],
  ['API', ['api', 'apis']], ['SQL', ['sql']], ['CSS', ['css']], ['HTML', ['html']],
  ['Figma', ['figma']], ['Canva', ['canva']], ['Photoshop', ['photoshop']],
  ['Blender', ['blender']], ['Obsidian', ['obsidian']], ['Notion', ['notion']],
  ['Discord', ['discord']], ['Slack', ['slack']], ['Telegram', ['telegram']],
  ['YouTube', ['youtube']], ['Spotify', ['spotify']], ['Steam', ['steam']],
  ['Garmin', ['garmin']], ['Health Connect', ['health connect']],
  ['Debugging', ['debug', 'debugging', '除錯', '偵錯', '调试', '調試']],
  ['Testing', ['unit test', 'unit tests', 'integration test', 'testing', '單元測試', '整合測試', '測試', '测试']],
  ['Deployment', ['deploy', 'deploying', 'deployment', '部署']],
  ['Code review', ['code review', 'pull request', 'pull requests', '程式碼審查', '代碼審查']],
  ['UI design', ['ui design', 'interface design', '介面設計', '界面設計']],
  ['Typography', ['typography', 'typeface', 'fonts', '字體', '字型', '排版']],
  ['Data visualization', ['visualization', 'visualisation', '資料視覺化', '數據可視化', '圖表', '图表']],
  ['Machine learning', ['machine learning', '機器學習', '机器学习']],
  ['LLMs', ['llm', 'llms', 'large language model', '大型語言模型', '大語言模型']],
  ['Research papers', ['research paper', 'papers', 'arxiv', '論文', '论文']],
  ['Documentation', ['documentation', 'readme', '技術文件', '說明文件']],
  ['Writing', ['writing', 'drafting', '寫作', '撰寫', '写作']],
  ['Presentations', ['presentation', 'slides', '簡報', '投影片']],
  ['Meetings', ['meeting', 'meetings', '會議', '会议']],
  ['Travel planning', ['itinerary', 'travel planning', '旅遊規劃', '行程規劃']],
];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = vocabulary.map(([name, aliases]) => ({ name, patterns: aliases.map((alias) =>
  // Latin words need token boundaries; Chinese phrases can occur without spaces.
  new RegExp(/^[\x00-\x7f]+$/.test(alias) ? `(?<![a-z0-9_])${escape(alias)}(?![a-z0-9_])` : escape(alias), 'iu')) }));

export function narrativeKeywords(title: string, summary = ''): string[] {
  const prose = `${title}\n${summary}`.normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/(?:[a-z]:\\|(?:~|\.)?\/)[^\s<>"']+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|tw|dev|app|so)\b/gi, ' ');
  return matchers.filter(({ patterns }) => patterns.some((pattern) => pattern.test(prose))).map(({ name }) => name);
}

export function dayflowKeywords(batches: DayflowBatch[], now: Date, limit = 12): DayflowKeyword[] {
  const counts = new Map<string, number>(), seen = new Set<string>();
  for (const batch of batches) for (const card of batch.cards) {
    const id = `${batch.deviceId}:${card.record_id}`;
    const start = Date.parse(`${batch.day}T04:00:00+08:00`);
    if (Math.min(+now, start + 86400000, Date.parse(card.end)) <= Math.max(start, Date.parse(card.start))) continue;
    if (card.category.toLowerCase() === 'idle' || card.category.toLowerCase() === 'system'
      || card.subcategory?.toLowerCase() === 'error' || batch.categories.find((c) => c.name === card.category)?.is_idle) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const name of narrativeKeywords(card.title, card.summary)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, mentions]) => ({ name, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'en')).slice(0, limit);
}
