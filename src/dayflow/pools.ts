import { narrativeKeywords, canonicalKeyword, isToolKeyword } from './keywords.js';
import { dayflowDay, type DayflowBatch, type DayflowKeywordPools } from './types.js';

// Common screen narration is not a topic. Recurring tools are deliberately
// absent from this list: their historical frequency is measured, not assumed.
const stop = new Set(`a about above across after again all almost along already also am an and another any around as at away back based be because been before began being below between both briefly but by can changes check checked checking close closed continued continuing could currently day days details did different do does doing done down during each earlier either else end ended enough even every everything few first focused following for found from further get gets getting given go going gone got had has have having he her here him his how however i if in including inside instead into is it its itself just keep keeping kept last later latest like little look looked looking made mainly make making many may meanwhile might more most mostly much must my near need needed needs new next no not notes now of off often on once one only onto or other others our out over own part past per placed previous previously progress recent recently related remaining repeatedly return returned returning same saw screen second see seeing seen several she should showed showing shows side since so some something soon spent started starting still such switched switching take taken taking than that the their them then there these they thing things this those through throughout thus time times to together too took toward under until up updated updating upon us use used user using various very via view viewed viewing views was watching way we well went were what when where whether which while who whole why will window windows with within without work worked working would yet you your
secret secrets private confidential password passwords token tokens credential credentials key keys title summary
add added adding adjust adjusted adjusting analyze analyzed analyzing browse browsed browsing build building change changing click clicked clicking compare compared comparing configure configured configuring create created creating edit edited editing explore explored exploring fix fixed fixing implement implemented implementing inspect inspected inspecting iterate iterated iterating modify modified modifying navigate navigated navigating prepare prepared preparing read reading refine refined refining review reviewed reviewing run running save saved saving scroll scrolled scrolling search searched searching select selected selecting send sending sent set setting share shared sharing show start stop stopped submit submitted switch test tested testing try tried trying update verify verified verifying visit visited visiting watch watched write wrote written writing
今天 昨天 目前 現在 之後 之前 接著 然後 同時 主要 持續 繼續 正在 進行 完成 開始 結束 最後 一個 一些 多個 不同 相關 內容 畫面 頁面 視窗 使用 透過 通過 以及 並且 與 和 在 的 了 著 到 從 對 將 以 為 是 有 沒有 可以 需要 查看 檢查 確認 瀏覽 閱讀 點擊 點選 切換 返回 開啟 打開 關閉 捲動 搜尋 輸入 修改 編輯 更新 調整 測試 嘗試 顯示 看到 討論 處理 設定 整理 準備 研究 分析 協助 建立 新增 重複 操作 工作 任務 記錄 摘要 使用者 自己 其中 這個 那個 這些 那些 什麼 如何 我們 他們 你的 我的 他的 它們 已經 仍然 可能 包含 例如 或者 為了 因為 所以 但是 部分 其他
现在 之后 接着 然后 同时 持续 继续 进行 开始 结束 最后 一个 一些 多个 相关 内容 画面 页面 窗口 通过 并且 从 对 将 为 没有 查看 检查 确认 浏览 阅读 点击 切换 返回 开启 打开 关闭 滚动 搜索 输入 编辑 调整 测试 尝试 显示 讨论 处理 设置 准备 协助 重复 任务 记录 用户 这个 那个 这些 那些 什么 如何 我们 他们 已经 仍然 为了 因为`.split(/\s+/));
for (const word of `執行 微調 分享 填寫 滑動 排定 個人 網站 隨後 並在 觀看 專案 影片 活動 開發 檢視 網頁 資料 頻道 修復 儀表 功能 紀錄 順便 問題 查詢 行動 驗證 動態 帳號 整合 按鈕 分類 個人資料 圖檔 放鬆 數據 瀏覽器 畫面中 頁面上 來回 對話 連結 區塊 清單 介面 終端 程式 代碼 程式碼 顯示出 呈現 接續 隨即 最終 進一步 並且在 再次 有關 並將 進入 完成後 停留 掃描 用於 內容中 內容為 主題 文字 訊息 簡短 新的 幾個 不過 把它 做了 了解 code data health project projects page pages app apps application applications browser chat chats message messages content interface panel dashboard files file section thread threads conversation conversations tab tabs request response issue issues feature features activity activities`.split(/\s+/)) stop.add(word);
for (const word of `scattered 規劃 登入 製作 修正 提交 比較 申請 追蹤 挑選 購買 審查 註冊 宣傳 錯誤 自動 規格 配對 擴充 機器 腳本 校園 手機 事宜 事項 待辦 pr fb store
飛 看 用 查 寫 做 買 逛 聊 跟 及 或 並 再 幫 請 找 給 把 被 讓 去 來 上 下 中 等 就 也 都 很 更 而 但 又 各 該 此 其 之 個 位 些 種 項 次 篇 張 份`.split(/\s+/)) stop.add(word);
const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const han = (value: string) => /^[\p{Script=Han}]+$/u.test(value);

// The segmenter splits unfamiliar Chinese names into single characters
// (竹|梅, 黑|客|松) and peels suffixes off compounds (口琴|社). Adjacent
// single characters are rejoined, and a lone character is folded onto the
// Han word right before it, unless either side is a function word.
function tokens(text: string): Array<{ index: number; segment: string }> {
  const result: Array<{ index: number; segment: string }> = [];
  for (const { index, segment } of segmenter.segment(text)) {
    if (!/\p{L}/u.test(segment)) continue;
    const prev = result[result.length - 1];
    if (prev && segment.length === 1 && han(prev.segment) && han(segment)
      && !stop.has(segment) && !stop.has(prev.segment) && prev.index + prev.segment.length === index) {
      prev.segment += segment;
      continue;
    }
    result.push({ index, segment });
  }
  return result;
}

function clean(value: string): string {
  return value.normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/(?:[a-z]:\\|(?:~|\.)?\/)[^\s<>"']+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, ' ')
    .replace(/\b(?:sk|ghp|github_pat|token|password|secret)[_-][a-z0-9_-]+\b/gi, ' ')
    .replace(/\b[a-z0-9_-]{24,}\b/gi, ' ')
    .replace(/\b\d[\d.:-]*\b/g, ' ');
}

function terms(value: string, phrases: boolean): Set<string> {
  const text = clean(value), segments = tokens(text);
  const result = new Set(narrativeKeywords(value));
  const valid = (s: string) => s.length >= 2 && s.length <= 24 && !stop.has(s.toLowerCase()) && /^[\p{L}][\p{L}-]+$/u.test(s);
  for (let i = 0; i < segments.length; i++) {
    const current = segments[i], word = current.segment.toLowerCase();
    if (!valid(word)) continue;
    const known = canonicalKeyword(word);
    result.add(known ?? word);
    const next = segments[i + 1];
    if (!phrases || !next || !valid(next.segment)) continue;
    if (!/^\s*$/.test(text.slice(current.index + current.segment.length, next.index))) continue;
    const [wordHan, nextHan] = [han(word), han(next.segment)];
    if (wordHan !== nextHan) continue; // mixed-script neighbours are rarely one name
    const pair = wordHan ? word + next.segment.toLowerCase() : word + ' ' + next.segment.toLowerCase();
    const knownPair = canonicalKeyword(pair);
    if (knownPair) result.add(knownPair);
    else if (pair.length <= 36 && !known && !canonicalKeyword(next.segment)) result.add(pair);
  }
  return result;
}

interface Document { day: string; terms: Set<string>; titleTerms: Set<string> }
interface Count { mentions: number; days: Set<string>; titles: number }
function documents(batches: DayflowBatch[], now: Date): Document[] {
  const result: Document[] = [], seen = new Set<string>();
  for (const batch of [...batches].sort((a, b) => b.observedAt.localeCompare(a.observedAt))) for (const card of batch.cards) {
    const id = batch.deviceId + ':' + card.record_id, start = Date.parse(batch.day + 'T04:00:00+08:00');
    if (Math.min(+now, start + 86400000, Date.parse(card.end)) <= Math.max(start, Date.parse(card.start))) continue;
    if (card.category.toLowerCase() === 'idle' || card.category.toLowerCase() === 'system'
      || card.subcategory?.toLowerCase() === 'error' || batch.categories.find((c) => c.name === card.category)?.is_idle || seen.has(id)) continue;
    seen.add(id);
    const titleTerms = terms(card.title, true);
    result.push({ day: batch.day, titleTerms, terms: new Set([...titleTerms, ...terms(card.summary ?? '', false)]) });
  }
  return result;
}
function corpus(docs: Document[]): Map<string, Count> {
  const result = new Map<string, Count>();
  for (const doc of docs) for (const name of doc.terms) {
    const value = result.get(name) ?? { mentions: 0, days: new Set(), titles: 0 };
    value.mentions++; value.days.add(doc.day); if (doc.titleTerms.has(name)) value.titles++;
    result.set(name, value);
  }
  return result;
}

export function keywordPools(batches: DayflowBatch[], now = new Date()): DayflowKeywordPools {
  const today = dayflowDay(now);
  const shift = (day: string, n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
  const recentFrom = shift(today, -6), baselineFrom = shift(recentFrom, -90), baselineTo = shift(recentFrom, -1);
  const docs = documents(batches.filter((b) => b.day >= baselineFrom && b.day <= today), now);
  const recentDocs = docs.filter((d) => d.day >= recentFrom), historyDocs = docs.filter((d) => d.day < recentFrom);
  const recent = corpus(recentDocs), history = corpus(historyDocs);
  const recentDays = new Set(recentDocs.map((d) => d.day)).size, baselineDays = new Set(historyDocs.map((d) => d.day)).size;
  const ready = baselineDays >= 14 && historyDocs.length >= 50;
  const candidates = [...recent].filter(([name, value]) => canonicalKeyword(name) === name || value.mentions >= 2 && value.titles >= 1);
  // Keep a descriptive phrase instead of a redundant fragment when it accounts
  // for nearly every occurrence of that fragment. Apply caps only after ranking.
  const specific = candidates.filter(([name, value]) => canonicalKeyword(name) === name || !candidates.some(([phrase, count]) =>
    phrase !== name && (phrase.includes(' ') ? phrase.toLowerCase().split(' ').includes(name.toLowerCase()) : /[\p{Script=Han}]/u.test(phrase) && phrase.includes(name)) && count.mentions >= value.mentions * 0.75));
  const all = specific.map(([name, value]) => ({ name, mentions: value.mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'en')).slice(0, 48);
  const distinctive = ready ? specific.flatMap(([name, value]) => {
    const old = history.get(name), historicalMentions = old?.mentions ?? 0, historicalDays = old?.days.size ?? 0;
    const lift = (value.mentions / Math.max(1, recentDocs.length)) / ((historicalMentions + 0.5) / (historyDocs.length + 1));
    if (value.mentions < 2 || historicalDays / baselineDays >= 0.35 || lift < 2) return [];
    const score = Math.log1p(value.mentions) * Math.log2(1 + lift) * (1 - historicalDays / baselineDays);
    return [{ name, mentions: value.mentions, historicalMentions, recentDays: value.days.size, historicalDays,
      lift: Math.round(lift * 10) / 10, score: Math.round(score * 100) / 100 }];
  }).sort((a, b) => b.score - a.score || b.mentions - a.mentions || a.name.localeCompare(b.name, 'en')).slice(0, 24) : [];
  return { all, distinctive, recentFrom, recentTo: today, baselineFrom, baselineTo, recentDays, baselineDays,
    recentActivities: recentDocs.length, baselineActivities: historyDocs.length, status: ready ? 'ready' : 'insufficient_history' };
}

export interface DayflowCloudTerm { name: string; mentions: number; days: number; seconds: number }

// Title terms with the attention time behind them, for the word cloud. Titles
// name what was being done (a club, a project, a trip); the tool vocabulary
// is left out because apps are where things happen, not what they are. A
// term must recur on separate days so one-off names never surface.
export function dayflowCloudTerms(batches: DayflowBatch[], now: Date, minDays = 2): DayflowCloudTerm[] {
  const totals = new Map<string, { mentions: number; days: Set<string>; seconds: number; forms: Map<string, number> }>(), seen = new Set<string>();
  for (const batch of [...batches].sort((a, b) => b.observedAt.localeCompare(a.observedAt))) for (const card of batch.cards) {
    const id = batch.deviceId + ':' + card.record_id, start = Date.parse(batch.day + 'T04:00:00+08:00');
    const span = Math.min(+now, start + 86400000, Date.parse(card.end)) - Math.max(start, Date.parse(card.start));
    if (span <= 0) continue;
    if (card.category.toLowerCase() === 'idle' || card.category.toLowerCase() === 'system'
      || card.subcategory?.toLowerCase() === 'error' || batch.categories.find((c) => c.name === card.category)?.is_idle || seen.has(id)) continue;
    seen.add(id);
    const title = clean(card.title);
    for (const name of terms(card.title, true)) {
      if (isToolKeyword(name)) continue;
      const value = totals.get(name) ?? { mentions: 0, days: new Set(), seconds: 0, forms: new Map() };
      value.mentions++; value.days.add(batch.day); value.seconds += Math.round(span / 1000);
      // Terms are lower-cased for counting; remember how the title spelt it.
      const form = canonicalKeyword(name) === name ? name : new RegExp(escape(name), 'iu').exec(title)?.[0] ?? name;
      value.forms.set(form, (value.forms.get(form) ?? 0) + 1);
      totals.set(name, value);
    }
  }
  const candidates = [...totals].filter(([, value]) => value.days.size >= minDays);
  const specific = candidates.filter(([name, value]) => canonicalKeyword(name) === name || !candidates.some(([phrase, count]) =>
    phrase !== name && (phrase.includes(' ') ? phrase.toLowerCase().split(' ').includes(name.toLowerCase()) : /[\p{Script=Han}]/u.test(phrase) && phrase.includes(name)) && count.mentions >= value.mentions * 0.75));
  return specific.map(([, value]) => ({
    name: [...value.forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    mentions: value.mentions, days: value.days.size, seconds: value.seconds,
  }))
    .sort((a, b) => b.seconds - a.seconds || b.mentions - a.mentions || a.name.localeCompare(b.name, 'en'));
}
