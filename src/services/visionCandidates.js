import { getIngredientGuidance } from '../data/ingredientKnowledge.js';
import { canonicalUnit } from './units.js';

const STORAGE_LOCATIONS = ['冷藏', '冷冻', '常温'];
const MODES = new Set(['tracked_quantity', 'freshness_only', 'approximate_stock']);

const SIMPLE_NAMES = [
  [/soy milk/i, '豆浆', 'Soy milk'], [/fish sauce/i, '鱼露', 'Fish sauce'], [/egg noodles?/i, '鸡蛋面', 'Egg noodles'], [/sweet potato(?:es)?/i, '红薯', 'Sweet potato'],
  [/\b(?:english\s+)?parsley\b/i, '欧芹', 'Parsley'],
  [/\b(?:coriander|cilantro)\b/i, '香菜', 'Coriander'],
  [/\b(?:spring onion|green onion|scallion)\b/i, '小葱', 'Scallion'],
  [/\bchicken breast\b/i, '鸡胸肉', 'Chicken breast'], [/\bchicken (?:wing|wings)\b/i, '鸡翅', 'Chicken wings'], [/\bchicken (?:leg|legs|thigh|thighs)\b/i, '鸡腿肉', 'Chicken thigh'], [/\bchicken\b/i, '鸡肉', 'Chicken'],
  [/\bground beef|minced beef\b/i, '牛肉碎', 'Ground beef'], [/\bbeef\b/i, '牛肉', 'Beef'], [/\bpork\b/i, '猪肉', 'Pork'],
  [/\b(?:shrimp|prawn)s?\b/i, '虾', 'Shrimp'], [/\bsalmon\b/i, '三文鱼', 'Salmon'], [/\bfish\b/i, '鱼', 'Fish'],
  [/\btofu\b/i, '豆腐', 'Tofu'], [/\beggs?\b/i, '鸡蛋', 'Eggs'], [/\bmilk\b/i, '牛奶', 'Milk'], [/\byog(?:h)?urt\b/i, '酸奶', 'Yogurt'],
  [/\btomato(?:es)?\b/i, '番茄', 'Tomato'], [/\bpotato(?:es)?\b/i, '土豆', 'Potato'], [/\bonions?\b/i, '洋葱', 'Onion'], [/\bgarlic\b/i, '大蒜', 'Garlic'], [/\bginger\b/i, '生姜', 'Ginger'],
  [/\bspinach\b/i, '菠菜', 'Spinach'], [/\bbroccoli\b/i, '西兰花', 'Broccoli'], [/\bcarrots?\b/i, '胡萝卜', 'Carrot'], [/\bcucumbers?\b/i, '黄瓜', 'Cucumber'], [/\blettuce\b/i, '生菜', 'Lettuce'], [/\bcabbage\b/i, '卷心菜', 'Cabbage'],
  [/\bbananas?\b/i, '香蕉', 'Banana'], [/\bapples?\b/i, '苹果', 'Apple'], [/\boranges?\b/i, '橙子', 'Orange'],
  [/\brice noodles?\b/i, '米粉', 'Rice noodles'], [/\bnoodles?\b/i, '面条', 'Noodles'], [/\bpasta\b/i, '意面', 'Pasta'], [/\brice\b/i, '大米', 'Rice'],
  [/\boyster sauce\b/i, '蚝油', 'Oyster sauce'], [/\bsoy sauce\b/i, '酱油', 'Soy sauce'], [/\bcooking oil\b/i, '食用油', 'Cooking oil']
];

function simplifyIngredientName(value = '', language = 'zh-CN') {
  const original = String(value).trim();
  const cleaned = original.replace(/\b(?:certified|organic|premium|fresh|imported)\b/gi, '').replace(/\s+/g, ' ').trim();
  // Whole names only: never turn soy milk into milk or fish sauce into fish.
  const matched = SIMPLE_NAMES.find(([pattern, chinese]) => new RegExp(`^(?:${pattern.source})$`, 'i').test(cleaned) || original === chinese);
  if (matched) return language === 'en' ? matched[2] : matched[1];
  if (language === 'en') return cleaned || original;
  if (/\p{Script=Han}/u.test(original)) {
    return original.replace(/^(?:认证|有机|精选|新鲜|进口)+/g, '').trim() || original;
  }
  return original;
}

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

export function normalizeVisionCandidate(raw = {}, language = 'zh-CN') {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const rawName = String(candidate.name || candidate.productName || candidate.ingredientName || '').trim();
  const name = simplifyIngredientName(rawName, language);
  const rawPackageState = String(candidate.packageState || '').toLowerCase();
  const packageState = rawPackageState === 'sealed' ? 'sealed' : rawPackageState === 'opened' ? 'opened' : 'unknown';
  const knowledge = getIngredientGuidance(simplifyIngredientName(rawName, 'zh-CN'), packageState === 'sealed' ? 'sealed' : 'opened');
  const knowledgeBackedStorage = knowledge?.confidence >= 0.9 ? knowledge.storage : null;
  const storageOptions = normalizeStorageOptions(knowledgeBackedStorage || candidate.storageOptions || candidate.storage || candidate.storageMethods);
  const countableTofu = /豆腐|tofu/i.test(`${name} ${candidate.normalizedName || ''}`);
  let suggestedManagementMode = MODES.has(candidate.suggestedManagementMode) ? candidate.suggestedManagementMode : candidate.mode;
  if (!MODES.has(suggestedManagementMode)) suggestedManagementMode = 'tracked_quantity';
  if (countableTofu) suggestedManagementMode = 'tracked_quantity';
  const unit = canonicalUnit(candidate.unit || (countableTofu ? '盒' : '个'));
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
    packageState,
    packageStateRelevant: Boolean(knowledge?.packageStateRelevant),
    storageLocation: preferred.location,
    storageOptions,
    expiryRequired: true,
    needsUserReview: Boolean(candidate.needsUserReview || packageState === 'unknown' || knowledge?.requiresPackageDate)
  };
}

export function normalizeVisionCandidates(raw, language = 'zh-CN') {
  return candidateEntries(raw).map((candidate) => normalizeVisionCandidate(candidate, language)).filter((candidate) => candidate.name);
}
