/**
 * Background Quota Auto-Refresher and Weekly Quota Smart Pre-warm
 */

import { fetchRealQuota, computeAccountQuotas } from './quota-fetcher.mjs';
import { testAccount } from './account-tester.mjs';
import { MODEL_LIST } from './models-catalog.mjs';

export const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
export const PREWARM_DEDUPE_MS = 6 * 24 * 3600 * 1000; // 6 天内最多一次
export const ACCOUNT_GAP_MS = 2500; // 账号之间间隔 2~3 秒

// 预热防重复时间记录：email -> { family -> timestamp }
const lastPrewarmStore = new Map();

export function getLastPrewarm(email, family) {
  const norm = (email || '').trim().toLowerCase();
  const rec = lastPrewarmStore.get(norm);
  if (!rec) return 0;
  return rec[family] || 0;
}

export function setLastPrewarm(email, family, timestamp) {
  const norm = (email || '').trim().toLowerCase();
  let rec = lastPrewarmStore.get(norm);
  if (!rec) {
    rec = {};
    lastPrewarmStore.set(norm, rec);
  }
  rec[family] = typeof timestamp === 'number' ? timestamp : Date.now();
}

export function clearLastPrewarms() {
  lastPrewarmStore.clear();
}

/**
 * 寻找当前可用模型中的一个 Claude Sonnet 模型
 */
export function findClaudeSonnetModel(models = MODEL_LIST) {
  const list = Array.isArray(models) ? models : (models?.data || MODEL_LIST);
  const found = list.find(m => {
    const id = (typeof m === 'string' ? m : m?.id || '').toLowerCase();
    return id.includes('claude') && id.includes('sonnet');
  });
  return typeof found === 'string' ? found : (found?.id || null);
}

/**
 * 判定某账号在某家族的周额度是否满足智能预热条件
 */
export function shouldPrewarmFamily({
  email,
  family,
  quotaData,
  lastPrewarmAt = 0,
  prewarmWeeklyEnabled = false,
  now = Date.now(),
}) {
  if (!prewarmWeeklyEnabled) return false;
  if (!email || !family) return false;
  if (family !== 'gemini' && family !== 'claude') return false;

  // 6 天去重
  if (lastPrewarmAt && (now - lastPrewarmAt < PREWARM_DEDUPE_MS)) {
    return false;
  }

  if (!quotaData || typeof quotaData !== 'object') return false;

  // 提取 7d 桶
  let bucket = quotaData[`${family}_7d`];
  if (!bucket && Array.isArray(quotaData.buckets)) {
    bucket = quotaData.buckets.find(b => b.window === '7d' && b.group === family);
  }
  if (!bucket || typeof bucket !== 'object') return false;

  const fraction = typeof bucket.remaining_fraction === 'number'
    ? bucket.remaining_fraction
    : (typeof bucket.fraction === 'number'
        ? bucket.fraction
        : (typeof bucket.percentage === 'number' ? bucket.percentage / 100 : null));

  if (typeof fraction !== 'number') return false;

  // 显示已重置/满额 (>= 1.0 或 >= 99%)
  if (fraction < 0.99) return false;

  // reset_time 为空或已过（即周期未开始计时）
  const resetTime = bucket.reset_time ?? bucket.reset ?? null;
  if (!resetTime) {
    return true; // 为空 -> 未开始计时
  }

  const resetMs = new Date(resetTime).getTime();
  if (Number.isNaN(resetMs)) {
    return true;
  }

  return resetMs <= now; // 已过 -> 周期未开始计时
}

/**
 * 对指定账号在指定家族执行极小测试请求完成预热
 */
export async function prewarmAccountFamily({
  email,
  family,
  accountPool,
  models = MODEL_LIST,
  fetchImpl,
  now = Date.now(),
}) {
  let modelToUse = null;
  if (family === 'gemini') {
    modelToUse = 'gemini-3.8-flash';
  } else if (family === 'claude') {
    modelToUse = findClaudeSonnetModel(models);
    if (!modelToUse) {
      return { ok: false, skipped: true, reason: 'no_claude_sonnet_model' };
    }
  } else {
    return { ok: false, skipped: true, reason: 'unsupported_family' };
  }

  // 记录预热时间，防止并发或重试触发
  setLastPrewarm(email, family, now);

  try {
    const res = await testAccount({
      email,
      model: modelToUse,
      accountPool,
      fetchImpl,
      timeoutMs: 15000,
    });
    return { ok: Boolean(res?.ok), model: modelToUse, result: res };
  } catch (err) {
    return { ok: false, model: modelToUse, error: err.message };
  }
}

/**
 * 单轮刷新所有账号额度并按需预热（纯函数逻辑，便于单元测试）
 */
export async function refreshAllQuotasOnce({
  accountPool,
  quotaCache = null,
  quotaFetcher = fetchRealQuota,
  fetchImpl = null,
  models = MODEL_LIST,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  now = Date.now(),
} = {}) {
  if (!accountPool || !accountPool.managers || accountPool.managers.size === 0) {
    const nextRun = now + REFRESH_INTERVAL_MS;
    if (accountPool && typeof accountPool.setQuotaRefreshStatus === 'function') {
      accountPool.setQuotaRefreshStatus({
        interval_min: 15,
        last_run_at: new Date(now).toISOString(),
        next_run_at: new Date(nextRun).toISOString(),
      });
    }
    return { count: 0, refreshed: [] };
  }

  const lastRunAt = now;
  const nextRunAt = now + REFRESH_INTERVAL_MS;
  accountPool.setQuotaRefreshStatus({
    interval_min: 15,
    last_run_at: new Date(lastRunAt).toISOString(),
    next_run_at: new Date(nextRunAt).toISOString(),
  });

  const emails = Array.from(accountPool.managers.keys());
  const refreshed = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const mgr = accountPool.getManager(email);
    if (mgr) {
      try {
        const quotaData = await quotaFetcher(mgr);
        if (quotaData && quotaData.ok && quotaData.email) {
          const familyQuotas = computeAccountQuotas(quotaData);
          if (quotaCache && typeof quotaCache.set === 'function') {
            quotaCache.set(quotaData.email, familyQuotas);
          }
          accountPool.updateQuota(quotaData.email, quotaData);
          refreshed.push(quotaData.email);

          // 7天周额度预热判定
          if (accountPool.prewarmWeekly) {
            for (const family of ['gemini', 'claude']) {
              const lastAt = getLastPrewarm(quotaData.email, family);
              const should = shouldPrewarmFamily({
                email: quotaData.email,
                family,
                quotaData,
                lastPrewarmAt: lastAt,
                prewarmWeeklyEnabled: true,
                now,
              });
              if (should) {
                await prewarmAccountFamily({
                  email: quotaData.email,
                  family,
                  accountPool,
                  models,
                  fetchImpl,
                  now,
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[QuotaRefresher] 刷新账号 ${email} 额度异常:`, e.message);
      }
    }

    if (i < emails.length - 1) {
      await sleep(ACCOUNT_GAP_MS);
    }
  }

  return { count: refreshed.length, refreshed };
}

let loopTimer = null;
let isRefreshing = false;

export function startQuotaRefreshLoop(accountPool, quotaCache, {
  intervalMs = REFRESH_INTERVAL_MS,
  initialDelayMs = 5000,
  models = MODEL_LIST,
} = {}) {
  if (loopTimer) return;
  const run = async () => {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      await refreshAllQuotasOnce({ accountPool, quotaCache, models });
    } catch (e) {
      console.warn('[QuotaRefresher] 定时刷新执行异常:', e.message);
    } finally {
      isRefreshing = false;
    }
  };

  const initialTimer = setTimeout(() => {
    run();
    loopTimer = setInterval(run, intervalMs);
    if (typeof loopTimer.unref === 'function') loopTimer.unref();
  }, initialDelayMs);

  if (typeof initialTimer.unref === 'function') initialTimer.unref();
}

export function stopQuotaRefreshLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}
