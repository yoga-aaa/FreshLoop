const STORAGE_LOCATIONS = ['冷藏', '冷冻', '常温'];
const MODES = new Set(['tracked_quantity', 'freshness_only', 'approximate_stock']);

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return value; }
}

function normalizeLocation(value = '') {
  const text = String(value).trim().toLowerCase();
  if (/冷藏|fridge|refrigerat/.test(text)) return '冷藏';
  if (/冷冻|freez/.test(text)) return '冷冻';
  if (/常温|室温|room|ambient/.test(text)) return '常温';
  return '';
}

function optionEntries(raw) {
  const parsed = parseMaybeJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.options)) return parsed.options;
  if (normalizeLocation(parsed.location || parsed.storageLocation)) return [parsed];
  return Object.entries(parsed).map(([key, value]) => {
    const next = parseMaybeJson(value);
    if (next && typeof next === 'object') return { location: key, ...next };
    return { location: key, days: next };
  });
}

function normalizeAvailable(value, rawText, days) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = `${value ?? ''} ${rawText ?? ''}`.toLowerCase();
  if (/false|不可|不建议|不适用|不能|no\b|unavailable/.test(text)) return false;
  if (/true|可以|可用|适用|yes\b|available/.test(text)) return true;
  return Number.isFinite(days);
}

function normalizeDays(value) {
  if (value == null || value === '') return null;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct > 0 ? Math.min(730, Math.round(direct)) : null;
  const matched = String(value).match(/\d+(?:\.\d+)?/);
  const parsed = matched ? Number(matched[0]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(730, Math.round(parsed)) : null;
}

export function normalizeStorageOptions(raw) {
  const entries = optionEntries(raw).map((entry) => {
    const object = entry && typeof entry === 'object' ? entry : {};
    const location = normalizeLocation(object.location || object.storageLocation || object.method || object.type);
    const rawText = object.note || object.advice || object.description || object.days || '';
    const days = normalizeDays(object.days ?? object.durationDays ?? object.shelfLifeDays ?? object.duration ?? rawText);
    return {
      ...object,
      location,
      days,
      available: normalizeAvailable(object.available ?? object.isAvailable ?? object.recommended, rawText, days),
      note: String(object.note || object.advice || object.description || '').trim()
    };
  }).filter((entry) => entry.location);

  return STORAGE_LOCATIONS.map((location) => {
    const matched = entries.find((entry) => entry.location === location);
    return matched || {
      location,
      days: null,
      available: false,
      note: '视觉模型未给出可靠的该储存方式，需人工确认'
    };
  });
}

function candidateEntries(raw) {
  const parsed = parseMaybeJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  if (parsed.name) return [parsed];
  return Object.values(parsed);
}

export function normalizeVisionCandidate(raw = {}) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const name = String(candidate.name || candidate.productName || candidate.ingredientName || '').trim();
  const storageOptions = normalizeStorageOptions(candidate.storageOptions || candidate.storage || candidate.storageMethods);
  const countableTofu = /豆腐|tofu/i.test(`${name} ${candidate.normalizedName || ''}`);
  let suggestedManagementMode = MODES.has(candidate.suggestedManagementMode) ? candidate.suggestedManagementMode : candidate.mode;
  if (!MODES.has(suggestedManagementMode)) suggestedManagementMode = 'tracked_quantity';
  if (countableTofu) suggestedManagementMode = 'tracked_quantity';
  const unit = String(candidate.unit || (countableTofu ? '盒' : '个')).trim();
  const numericQuantity = Number(candidate.quantity);
  const quantity = suggestedManagementMode === 'tracked_quantity'
    ? (Number.isFinite(numericQuantity) && numericQuantity > 0 ? numericQuantity : 1)
    : candidate.quantity;
  const requestedLocation = normalizeLocation(candidate.storageLocation);
  const preferred = storageOptions.find((option) => option.location === requestedLocation && option.available)
    || storageOptions.find((option) => option.available)
    || storageOptions[0];

  return {
    ...candidate,
    name,
    normalizedName: String(candidate.normalizedName || candidate.canonicalName || name).trim().toLowerCase(),
    suggestedManagementMode,
    quantity,
    unit,
    storageLocation: preferred.location,
    storageOptions
  };
}

export function normalizeVisionCandidates(raw) {
  return candidateEntries(raw).map(normalizeVisionCandidate).filter((candidate) => candidate.name);
}
