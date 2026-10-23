/**
 * Real-time Google Antigravity Quota Telemetry Fetcher (v2 - strict)
 *
 * 核心原则：宁可显示 '--'，也绝不伪造 100%。
 * 1. 遍历全部模型条目，收集所有能识别到的真实配额数据（兼容多种字段形态）；
 * 2. 从 {limit, usage} / {remaining, total} / remainingFraction 精确计算百分比；
 * 3. Google 某桶无数据时返回 null，前端渲染为 '--'。
 */

function parseResetTime(resetTimeStr) {
  if (!resetTimeStr) return null;
  try {
    const target = new Date(resetTimeStr).getTime();
    if (Number.isNaN(target)) return null;
    const diff = target - Date.now();
    if (diff <= 0) return '已重置';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainHours = hours % 24;
      return remainHours > 0 ? `${days}天${remainHours}小时后` : `${days}天后`;
    }
    if (hours > 0) {
      return `${hours}小时${mins}分后`;
    }
    return `${mins}分钟后`;
  } catch (e) {
    return null;
  }
}

function hoursUntil(resetTimeStr) {
  if (!resetTimeStr) return -1;
  const t = new Date(resetTimeStr).getTime();
  return Number.isNaN(t) ? -1 : (t - Date.now()) / 3600000;
}

/**
 * 官方配额第一权威来源：retrieveUserQuotaSummary
 * 官方明确定义两组：
 * 1) Gemini Models (gemini-5h, gemini-weekly)
 * 2) Claude and GPT models (3p-5h, 3p-weekly)
 */
async function fetchQuotaSummary(accessToken, project) {
  const bases = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com'
  ];
  const body = project ? JSON.stringify({ project }) : '{}';
  const tasks = bases.map(base =>
    fetch(`${base}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.10.2 linux/arm64'
      },
      body,
      signal: AbortSignal.timeout(8000),
    }).then(res => (res.ok ? res.json() : null)).catch(() => null)
  );

  const settled = await Promise.allSettled(tasks);
  const out = {};

  for (const s of settled) {
    if (s.status !== 'fulfilled' || !s.value) continue;
    const d = s.value;
    const payload = d?.response || d;
    const groups = payload?.groups || [];

    for (const g of groups) {
      const gName = String(g.displayName || '').toLowerCase();
      const isGeminiGroup = gName.includes('gemini');
      const isClaudeGroup = gName.includes('claude') || gName.includes('3p') || gName.includes('gpt');
      const family = isGeminiGroup ? 'gemini' : (isClaudeGroup ? 'claude' : null);
      if (!family) continue;

      for (const b of (g.buckets || [])) {
        const id = String(b.bucketId || b.bucket_id || '').toLowerCase();
        const win = String(b.window || '').toLowerCase();
        const frac = b.remainingFraction ?? b.remaining_fraction ?? b.remaining?.remainingFraction;
        const resetTime = b.resetTime || b.reset_time || null;
        if (typeof frac !== 'number') continue;

        const isWeekly = win.includes('week') || id.includes('week');
        const isFiveHour = win.includes('5h') || id.includes('5h');
        const period = isWeekly ? '7d' : (isFiveHour ? '5h' : null);
        if (!period) continue;

        const key = `${family}_${period}`;
        if (!out[key] || frac < out[key].fraction) {
          out[key] = {
            fraction: Math.max(0, Math.min(1, frac)),
            reset: resetTime,
            source: 'official_summary',
            inferred: false,
          };
        }
      }
    }
  }

  return Object.keys(out).length ? out : null;
}

/** 从模型详情 extractFromEntry */
function extractFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.remainingFraction === 'number' && entry.remainingFraction >= 0) {
    return { fraction: entry.remainingFraction, reset: entry.resetTime || entry.reset_time || null, source: 'model_info' };
  }
  const limit = entry.limit ?? entry.quotaLimit ?? entry.max;
  const usage = entry.usage ?? entry.consumed ?? entry.used;
  if (typeof limit === 'number' && limit > 0) {
    const u = typeof usage === 'number' ? usage : 0;
    return { fraction: Math.max(0, Math.min(1, 1 - u / limit)), reset: entry.resetTime || entry.reset_time || null, source: 'model_info' };
  }
  return null;
}

function toPublic(r, fallbackLabel = '正常') {
  if (!r) return null;
  const bound = r.bound || null;
  return {
    remaining_fraction: r.fraction,
    percentage: typeof r.fraction === 'number' ? Math.round(r.fraction * 100) : null,
    bound,
    note: r.note || null,
    inferred: !!r.inferred,
    reset_time: r.reset,
    reset_text: r.status_text || parseResetTime(r.reset) || fallbackLabel,
    source: r.source || 'telemetry',
    constrained_by_weekly: bound === 'constrained' || !!r.constrained_by_weekly,
  };
}

export async function fetchRealQuota(tokenManager) {
  if (!tokenManager || !tokenManager.tokenData?.refreshToken) {
    return {
      ok: false,
      message: '尚未配置 Google 账号',
      email: '未登录',
      gemini_5h: null,
      gemini_7d: null,
      claude_5h: null,
      claude_7d: null,
      updated_time: new Date().toLocaleTimeString(),
    };
  }

  const accessToken = await tokenManager.getValidAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      message: 'Google 凭据失效',
      email: tokenManager.tokenData.email,
      gemini_5h: null,
      gemini_7d: null,
      claude_5h: null,
      claude_7d: null,
      updated_time: new Date().toLocaleTimeString(),
    };
  }

  try {
    let project = tokenManager.tokenData.projectId || '';
    if ((!project || project === 'pending_detection') && typeof tokenManager.ensureProjectId === 'function') {
      try {
        project = await Promise.resolve(tokenManager.ensureProjectId()).catch(() => '') || '';
      } catch (_) { project = ''; }
    }
    if (project === 'pending_detection') project = '';

    // 1. 优先拉取官方分组汇总接口 (权威源)
    let summaryData = null;
    try {
      summaryData = await fetchQuotaSummary(accessToken, project);
    } catch (_) {}

    const merged = {
      gemini_5h: summaryData?.gemini_5h || null,
      gemini_7d: summaryData?.gemini_7d || null,
      claude_5h: summaryData?.claude_5h || null,
      claude_7d: summaryData?.claude_7d || null,
    };

    // 2. 如果官方 summary 缺少 Gemini 配额（许多账号在 summary 中只有 3p 组），从 fetchAvailableModels 获取 Gemini 模型实际真实配额
    if (!merged.gemini_5h) {
      try {
        const { CLOUDCODE_API_ENDPOINT, ANTIGRAVITY_ENDPOINT_DAILY } = await import('./constants.mjs');
        const endpoints = [ANTIGRAVITY_ENDPOINT_DAILY, CLOUDCODE_API_ENDPOINT];
        let modelsData = null;
        for (const base of endpoints) {
          try {
            const res = await fetch(`${base}/v1internal:fetchAvailableModels`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/1.10.2 linux/arm64',
              },
              body: project ? JSON.stringify({ project }) : '{}',
              signal: AbortSignal.timeout(6000),
            });
            if (res.ok) { modelsData = await res.json(); break; }
          } catch (_) {}
        }

        if (modelsData?.models) {
          for (const [mName, mInfo] of Object.entries(modelsData.models)) {
            const lower = mName.toLowerCase();
            if (!lower.includes('gemini')) continue;
            const r = extractFromEntry(mInfo?.quotaInfo);
            if (r && typeof r.fraction === 'number') {
              // 科学判定：重置时间 > 24 小时属于多日/周配额；<= 24 小时属于当前短周期
              const isLongTerm = hoursUntil(r.reset) > 24;
              const targetKey = isLongTerm ? 'gemini_7d' : 'gemini_5h';
              if (!merged[targetKey] || r.fraction < merged[targetKey].fraction) {
                merged[targetKey] = r;
              }
            }
          }
        }
      } catch (_) {}
    }

    // 3. 精确周限额兜底：
    // a) 若 5h 缺失、7d 存在（受周限额锁定）：
    if (!merged.gemini_5h && merged.gemini_7d) {
      merged.gemini_5h = {
        fraction: merged.gemini_7d.fraction,
        reset: null, // 绝不抄周额度的时间
        source: 'inferred-constrained',
        bound: 'constrained',
        status_text: '受周限额约束',
        note: '受周限额约束',
        constrained_by_weekly: true,
        inferred: true,
      };
    }

    // b) 若 7d 周额度未单独返回且 5h 存在（未触发周限额限制）：
    if (!merged.gemini_7d && merged.gemini_5h) {
      merged.gemini_7d = {
        fraction: merged.gemini_5h.fraction,
        reset: null,
        source: 'unconstrained',
        bound: 'gte',
        status_text: '未触发周限',
        note: '未触发周限',
        inferred: true,
      };
    }

    if (!merged.claude_7d && merged.claude_5h) {
      merged.claude_7d = {
        fraction: merged.claude_5h.fraction,
        reset: null,
        source: 'unconstrained',
        bound: 'gte',
        status_text: '未触发周限',
        note: '未触发周限',
        inferred: true,
      };
    }

    const result = {
      ok: true,
      email: tokenManager.tokenData.email,
      project: project || null,
      gemini_5h: toPublic(merged.gemini_5h),
      gemini_7d: toPublic(merged.gemini_7d),
      claude_5h: toPublic(merged.claude_5h),
      claude_7d: toPublic(merged.claude_7d),
      updated_unix: Math.floor(Date.now() / 1000),
      updated_time: new Date().toLocaleTimeString(),
    };

    // 兼容字段
    result.five_hour = {
      percentage: result.gemini_5h?.percentage ?? null,
      reset_time: result.gemini_5h?.reset_time || null,
      bound: result.gemini_5h?.bound || null,
      constrained_by_weekly: !!result.gemini_5h?.constrained_by_weekly,
    };
    result.claude_five_hour = {
      percentage: result.claude_5h?.percentage ?? null,
      reset_time: result.claude_5h?.reset_time || null,
      bound: result.claude_5h?.bound || null,
      constrained_by_weekly: !!result.claude_5h?.constrained_by_weekly,
    };
    result.weekly = {
      percentage: result.gemini_7d?.percentage ?? null,
      bound: result.gemini_7d?.bound || null,
    };

    return result;
  } catch (err) {
    return {
      ok: false,
      message: err.message,
      email: tokenManager.tokenData.email,
      gemini_5h: null,
      gemini_7d: null,
      claude_5h: null,
      claude_7d: null,
      five_hour: { percentage: null, reset_time: null },
      claude_five_hour: { percentage: null, reset_time: null },
      weekly: { percentage: null },
      updated_time: new Date().toLocaleTimeString(),
    };
  }
}
