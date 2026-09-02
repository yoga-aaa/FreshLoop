import { canonicalUnit } from './units.js';

const CONSTRAINT_ALIASES = [
  ['花生', 'peanut', 'peanuts', 'groundnut'], ['香菜', 'coriander', 'cilantro'], ['欧芹', 'parsley'],
  ['葱', '葱花', '小葱', 'scallion', 'spring onion', 'green onion'], ['虾', '虾米', '虾酱', 'shrimp', 'prawn'],
  ['牛奶', '乳制品', '奶制品', 'milk', 'dairy', 'cheese', 'butter', 'cream', 'yogurt', '乳酪', '黄油', '奶油', '酸奶'],
  ['鸡蛋', '蛋类', 'egg', 'eggs'], ['大豆', '豆制品', 'soy', 'soya', 'tofu', '豆腐', '豆浆', '酱油'],
  ['芝麻', 'sesame'], ['小麦', 'wheat'], ['鱼', 'fish', 'salmon', '三文鱼'], ['蚝', 'oyster'],
  ['辣椒', '小米辣', 'chili', 'chilli'], ['猪肉', 'pork'], ['牛肉', 'beef']
];

function containsFoodName(text, name) {
  if (/[\u3400-\u9fff]/.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:s)?\\b`, 'i').test(text);
}

function violatesConstraint(ingredient, constraints, broad = false) {
  const text = `${ingredient.canonicalName || ''} ${ingredient.name || ''}`.toLowerCase();
  return constraints.some((value) => {
    const constraint = String(value).toLowerCase().trim();
    if (!constraint) return false;
    // Allergy groups are conservative; dislikes match names rather than all dairy, etc.
    const aliases = CONSTRAINT_ALIASES.find((group) => group.includes(constraint));
    const names = aliases && (broad || aliases.length < 8) ? aliases : [constraint];
    return names.some((name) => containsFoodName(text, name));
  });
}

const MODE_LABELS = {
  tracked_quantity: '精细消耗',
  freshness_only: '新鲜度',
  approximate_stock: '估算库存'
};

export function modeLabel(mode) { return MODE_LABELS[mode] || mode; }

export function daysUntil(dateString, now = new Date()) {
  if (!dateString) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(`${dateString}T00:00:00`);
  return Math.ceil((target - today) / 86400000);
}

export function expiryTone(item, now = new Date()) {
  const days = daysUntil(item.expiryDate, now);
  if (days == null) return 'neutral';
  if (days < 0) return 'purple';
  if (days <= 3) return 'pink';
  if (days <= 6) return 'blue';
  return 'green';
}

export function expiryLabel(item, now = new Date()) {
  const days = daysUntil(item.expiryDate, now);
  if (days == null) return null;
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  if (days === 1) return '明天到期';
  return `${days} 天后到期`;
}

export function sortInventoryByExpiry(items, now = new Date()) {
  return [...items].sort((a, b) => {
    const aDays = daysUntil(a.expiryDate, now);
    const bDays = daysUntil(b.expiryDate, now);
    if (aDays == null && bDays == null) return a.name.localeCompare(b.name, 'zh-CN');
    if (aDays == null) return 1;
    if (bDays == null) return -1;
    return aDays - bDays;
  });
}

export function freshnessLabel(item) {
  if (item.freshnessStatus === 'use_soon') return '建议尽快使用';
  if (item.freshnessStatus === 'expired_or_past_recorded_date') return '请检查日期';
  if (item.freshnessStatus === 'uncertain') return '信息不确定';
  return '状态良好';
}

export function freshnessClass(item) {
  if (item.freshnessStatus === 'use_soon') return 'warning';
  if (item.freshnessStatus === 'expired_or_past_recorded_date') return 'danger';
  if (item.freshnessStatus === 'uncertain') return 'muted';
  return 'success';
}

export function formatStock(item) {
  if (item.managementMode === 'freshness_only') return '用完即删';
  if (item.managementMode === 'approximate_stock') {
    if (item.stockPercentage == null) return '待确认';
    if (item.stockPercentage <= 20) return `约 ${item.stockPercentage}% · 快用完`;
    if (item.stockPercentage <= 35) return `约 ${item.stockPercentage}% · 偏少`;
    if (item.stockPercentage <= 65) return `约 ${item.stockPercentage}%`;
    return `约 ${item.stockPercentage}% · 充足`;
  }
  return `剩余约 ${item.quantity ?? '待确认'} ${item.unit || ''}`.trim();
}

export function findInventoryItem(inventory, canonicalName) {
  return inventory.find((item) => item.canonicalName === canonicalName || item.name === canonicalName);
}

export function validateRecipe(recipe, inventory, profile) {
  const errors = [];
  const inventoryByName = new Map(inventory.map((item) => [item.canonicalName, item]));
  for (const ingredient of recipe.ingredients || []) {
    const current = inventoryByName.get(ingredient.canonicalName);
    if (current?.managementMode === 'tracked_quantity' && (!ingredient.unit || canonicalUnit(ingredient.unit) === canonicalUnit(current.unit)) && Number(ingredient.requiredAmount) > Number(current.quantity)) {
      errors.push(`${ingredient.name}库存不足`);
    }
    if (violatesConstraint(ingredient, profile.allergies || [], true)) {
      errors.push(`违反过敏硬约束：${ingredient.name}`);
    }
    if (violatesConstraint(ingredient, profile.dislikes || [])) {
      errors.push(`包含用户明确不喜欢的食材：${ingredient.name}`);
    }
  }
  return errors;
}

export function buildShoppingList(recipe, inventory) {
  return (recipe.ingredients || []).flatMap((ingredient) => {
    const current = findInventoryItem(inventory, ingredient.canonicalName);
    if (!current) return [{ ...ingredient, status: 'to_buy', reason: '库存中没有该食材', available: null }];
    if (current.managementMode === 'freshness_only') return [{ ...ingredient, status: 'need_confirm', reason: '数量未追踪，请确认家中余量', available: '未知' }];
    if (current.managementMode === 'approximate_stock') {
      return current.stockPercentage > 20 ? [] : [{ ...ingredient, status: 'need_confirm', reason: '估算库存偏低，请确认是否需要补货', available: `约 ${current.stockPercentage}%` }];
    }
    if (ingredient.unit && canonicalUnit(ingredient.unit) !== canonicalUnit(current.unit)) return [{ ...ingredient, status: 'need_confirm', reason: `库存按“${current.unit}”记录，请确认是否足够`, available: `${current.quantity} ${current.unit}` }];
    if (Number(ingredient.requiredAmount) <= Number(current.quantity)) return [];
    return [{ ...ingredient, status: 'to_buy', reason: '精细库存不足', available: `${current.quantity} ${current.unit}` }];
  });
}

export function applyMealConsumption(state, recipe, actualById = {}) {
  const events = [];
  const removeIds = new Set();
  for (const ingredient of recipe.ingredients || []) {
    const item = findInventoryItem(state.inventory, ingredient.canonicalName);
    if (!item) continue;
    const review = actualById[item.id];
    const amount = Number((review && typeof review === 'object' ? review.amount : review) ?? ingredient.requiredAmount);
    if (item.managementMode === 'tracked_quantity') {
      const before = Number(item.quantity);
      item.quantity = Math.max(0, Number(item.quantity) - amount);
      events.push({ type: 'consume', inventoryItemId: item.id, amount, unit: item.unit, before, remaining: item.quantity });
    } else if (item.managementMode === 'approximate_stock' && item.stockPercentage != null) {
      const before = Number(item.stockPercentage);
      const reviewedRemaining = review && typeof review === 'object' ? Number(review.remainingPercentage) : null;
      item.stockPercentage = Number.isFinite(reviewedRemaining) ? Math.max(0, Math.min(100, reviewedRemaining)) : Math.max(0, before - Math.min(20, amount / 10));
      events.push({ type: 'reviewed_stock', inventoryItemId: item.id, before, remaining: item.stockPercentage, unit: '%' });
    } else if (item.managementMode === 'freshness_only' && review?.usedUp) {
      removeIds.add(item.id);
      events.push({ type: 'used_up', inventoryItemId: item.id, remaining: 0, unit: item.unit });
    }
  }
  if (removeIds.size) state.inventory = state.inventory.filter((item) => !removeIds.has(item.id));
  return events;
}
