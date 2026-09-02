import './styles.css';
import { store } from './state/store.js';
import { analyzeInventory, cancelAllAiRequests, enrichRecipeImages, generateRecipes, getStorageGuidance } from './services/ai.js';
import { buildTasteProfile, hasRemoteAuth, loadRemoteProfile, requestPhoneOtp, savePlannedMeal, saveRemoteProfile, sendReminderSms, verifyPhoneOtp } from './services/auth.js';
import { getIngredientGuidance, ingredientIcon } from './data/ingredientKnowledge.js';
import { applyMealConsumption, buildShoppingList, daysUntil, expiryLabel, expiryTone, findInventoryItem, formatStock, sortInventoryByExpiry, validateRecipe } from './services/domain.js';
import { condimentInventory, recipeSelectableInventory } from './services/recipePolicy.js';
import { buildPlanReviewAt, localDateKey, nextPlanForReview, snoozePlanReview } from './services/planning.js';

const app = document.querySelector('#app');
const VIEW_KEYS = ['activeTab', 'recipeMode', 'selectedRecipeId', 'recipeReturnMode'];

function viewSnapshot(state = store.get()) {
  return VIEW_KEYS.reduce((view, key) => ({ ...view, [key]: state[key] ?? null }), {});
}

function navigateView(patch, { replace = false } = {}) {
  const currentHistory = window.history.state?.freshloop ? window.history.state : { depth: 0 };
  const nextView = { ...viewSnapshot(), ...patch };
  const entry = { freshloop: true, depth: replace ? (currentHistory.depth || 0) : (currentHistory.depth || 0) + 1, view: nextView };
  window.history[replace ? 'replaceState' : 'pushState'](entry, '', window.location.href);
  store.set(patch);
}

function returnWithinApp(fallback) {
  if (window.history.state?.freshloop && Number(window.history.state.depth || 0) > 0) window.history.back();
  else navigateView(fallback, { replace: true });
}

window.addEventListener('popstate', (event) => {
  if (!event.state?.freshloop || !event.state.view) return;
  const route = VIEW_KEYS.reduce((patch, key) => {
    if (Object.hasOwn(event.state.view, key)) patch[key] = event.state.view[key];
    return patch;
  }, {});
  store.set(route);
});

app.addEventListener('click', (event) => {
  const card = event.target.closest('[data-recipe-card]');
  if (!card || event.target.closest('button, a, input, select, textarea, [data-card-control]')) return;
  openRecipeDetail(card.dataset.recipeCard);
});
app.addEventListener('keydown', (event) => {
  const card = event.target.closest('[data-recipe-card]');
  if (!card || !['Enter', ' '].includes(event.key) || event.target.closest('button, a, input, select, textarea, [data-card-control]')) return;
  event.preventDefault();
  openRecipeDetail(card.dataset.recipeCard);
});
let notificationTimer = null;
let lastNotificationKey = '';
let expiredPromptQueued = false;
let planPromptQueued = false;
const planPromptShown = new Set();
const imageHydrationRequested = new Set();
let profileSyncTimer = null;
let recipeGenerationRun = 0;

const CATEGORY_LABELS = { all: '全部', protein: '肉蛋奶及蛋白质', produce: '蔬菜水果', staple: '主食及碳水', condiment: '调味品', other: '其他食品' };
const STORAGE_VALUES = ['冷藏', '冷冻', '常温'];
const COUNT_UNITS = ['个', '瓶', '袋', '盒', '包', '块', '颗', '根', '杯', '把', '份'];
const TASTE_OPTIONS = ['酸香', '甜口', '微苦回甘', '辣', '鲜香', '清淡', '浓郁'];
const CUISINE_OPTIONS = ['中式家常', '川湘', '粤式', '江浙', '新加坡/南洋', '日式', '韩式', '西式', '地中海'];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function safeSourceUrl(value = '') {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}

function icon(name) {
  const paths = {
    leaf: '<path d="M20 4C10 4 4 9 4 19c10 1 16-4 16-15Z"/><path d="M4 20c3-5 7-8 12-10"/>',
    spark: '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/>',
    user: '<circle cx="12" cy="8" r="3"/><path d="M5 21c.7-4 2.9-6 7-6s6.3 2 7 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 22h4"/>',
    cart: '<path d="M3 4h2l2 12h10l3-9H6"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
    upload: '<path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 15v5h16v-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    wand: '<path d="m4 20 10-10M12 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3ZM18 14l.7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z"/>'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function recipeImage(recipe) {
  if (recipe.image?.url) return recipe.image.url;
  const hash = [...String(recipe.recipeName || '')].reduce((total, char) => total + char.charCodeAt(0), 0);
  const palettes = [['#eef7e8','#bfd7aa'], ['#fff1e5','#e8bf92'], ['#f4eaf7','#ccb2d7'], ['#e8f3f7','#a8ccd5']];
  const [start, end] = palettes[hash % palettes.length];
  const emoji = recipe.emoji || ingredientIcon(recipe.ingredients?.[0]?.name || '') || '🍽️';
  const xml = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  const title = xml(String(recipe.recipeName || '今日菜品').slice(0, 18));
  const ingredients = xml((recipe.ingredients || []).slice(0, 3).map((item) => item.name).filter(Boolean).join(' · '));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="600" cy="305" r="175" fill="white" opacity=".82"/><text x="600" y="380" text-anchor="middle" font-size="150">${emoji}</text><text x="600" y="565" text-anchor="middle" font-family="sans-serif" font-size="54" font-weight="700" fill="#173125">${title}</text><text x="600" y="628" text-anchor="middle" font-family="sans-serif" font-size="29" fill="#607269">${ingredients}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function render() {
  const state = store.get();
  if (!state.auth?.authenticated) {
    app.innerHTML = renderAuthPage(state);
    bindAuthEvents();
    return;
  }
  if (!state.auth.onboardingComplete) {
    app.innerHTML = renderOnboarding(state);
    bindOnboardingEvents();
    return;
  }
  const views = { inventory: renderInventory, recipe: renderRecipe, shopping: renderShopping, profile: renderProfileV4 };
  app.innerHTML = `<div class="app-shell"><header class="topbar"><button class="brand-button" data-tab="inventory" aria-label="返回食材库"><span class="brand-mark">${icon('leaf')}</span><span><small>FRESHLOOP</small><strong>把食材用在刚好的时候</strong></span></button><div class="header-actions"><button class="header-plan" data-tab="recipe">${icon('spark')} 看看今日推荐</button><button class="icon-button" data-action="show-reminder" aria-label="查看通知">${icon('bell')}<span class="notification-dot"></span></button></div></header><main class="content">${views[state.activeTab]?.(state) || renderInventory(state)}</main>${renderNav(state.activeTab)}${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}</div>` : ''}</div>`;
  polishInventorySurface();
  bindEvents();
  queueMissingRecipeImages();
  queueExpiredPrompt();
  queueDuePlanReview();
}

function queueMissingRecipeImages() {
  const state = store.get();
  const visible = state.recipeMode === 'feed' ? state.dailyRecommendations : state.recipes;
  const acceptedPolicies = new Set(['openverse-relevance-v1', 'xiachufang-reference-v1']);
  const missing = visible.filter((recipe) => !acceptedPolicies.has(recipe.image?.policyVersion) && !imageHydrationRequested.has(recipe.id));
  if (!missing.length) return;
  missing.forEach((recipe) => imageHydrationRequested.add(recipe.id));
  hydrateRecipeImages(missing, state.recipeMode === 'feed' ? 'daily' : 'custom');
}

function polishInventorySurface() {
  app.querySelector('.upcoming-strip')?.remove();
  const panel = app.querySelector('.capture-panel');
  if (!panel) return;
  const title = panel.querySelector(':scope > strong');
  const copy = panel.querySelector(':scope > p');
  const primary = panel.querySelector(':scope > .primary-button');
  const secondary = panel.querySelector(':scope > .capture-buttons');
  if (title) title.textContent = '录入新食材';
  if (copy) copy.textContent = '手动添加一项，或上传小票、食材合照后统一核对。';
  if (primary && secondary) panel.insertBefore(primary, secondary);
}

function renderAuthPage(state) {
  const stage = state.auth?.stage || 'phone';
  return `<main class="auth-shell"><section class="auth-story"><span class="brand-mark large">${icon('leaf')}</span><p class="eyebrow">FRESHLOOP</p><h1>把食材用在<br>刚好的时候</h1><p>记住你的库存、口味和生活节奏，把每一次推荐变成真正适合你的那一餐。</p><div class="auth-points"><span>按食材与温度检索储存建议</span><span>菜谱会避开过敏与明确忌口</span><span>采购、提醒与餐后记录连在一起</span></div></section><section class="auth-card"><p class="eyebrow">${stage === 'otp' ? 'VERIFY PHONE' : 'SIGN IN OR REGISTER'}</p><h2>${stage === 'otp' ? '输入短信验证码' : '用手机号开始'}</h2><p>${stage === 'otp' ? `验证码已发送至 ${escapeHtml(state.auth.phone)}。首次登录后会用两分钟建立饮食画像。` : '注册与登录使用同一入口。手机号验证后，你的档案可以安全同步到后端。'}</p>${stage === 'otp' ? `<form data-form="verify-otp" class="auth-form"><label>6 位验证码<input name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required></label><button class="primary-button" type="submit">验证并继续</button></form><button class="text-button auth-back" data-action="change-phone">换一个手机号</button>${!hasRemoteAuth() ? '<div class="demo-code">本地演示模式：验证码 <strong>123456</strong></div>' : ''}` : `<form data-form="phone-auth" class="auth-form"><label>手机号<input name="phone" type="tel" autocomplete="tel" placeholder="例如 +65 8123 4567" required></label><small>请包含国家/地区代码；验证短信可能产生运营商费用。</small><button class="primary-button" type="submit">获取短信验证码</button></form>`}<div class="auth-divider"><span>或</span></div><button class="secondary-button full-width" data-action="demo-enter">直接体验演示</button><small class="auth-legal">继续即表示你同意仅将手机号用于登录与已授权提醒；短信提醒可随时关闭。</small></section>${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}</div>` : ''}</main>`;
}

function renderOnboarding(state) {
  const profile = state.profile;
  return `<main class="onboarding-shell"><header class="onboarding-brand"><span class="brand-mark">${icon('leaf')}</span><span><small>FRESHLOOP</small><strong>先认识你的餐桌</strong></span><em>约 2 分钟 · 之后都能在档案修改</em></header><form class="onboarding-card" data-form="onboarding"><div class="onboarding-heading"><p class="eyebrow">FIRST SETUP</p><h1>让推荐真正适合你</h1><p>过敏与明确忌口是硬约束；口味偏好会影响调料种类、用量和地区做法。</p></div><section class="onboarding-section required-section"><div><span class="step-number">1</span><h2>必须先知道的饮食信息</h2></div><div class="onboarding-grid two"><label>怎么称呼你<input name="name" value="${escapeHtml(profile.name || '')}" placeholder="例如：小瑜、Alex" required></label><label>过敏食材<input name="allergies" value="${escapeHtml((profile.allergies || []).join('、'))}" placeholder="例如：花生、虾；没有请填“无”" required></label><label>明确不喜欢或忌口<input name="dislikes" value="${escapeHtml((profile.dislikes || []).join('、'))}" placeholder="例如：香菜、葱；没有请填“无”" required></label><label>其他补充<input name="tasteNotes" value="${escapeHtml(profile.tasteNotes || '')}" placeholder="例如：喜欢微辣、少油、偏爱有汤汁"></label></div><fieldset><legend>喜欢的味道（可多选）</legend><div class="choice-cloud">${TASTE_OPTIONS.map((item) => `<label><input type="checkbox" name="tasteTags" value="${item}" ${(profile.tasteTags || []).includes(item) ? 'checked' : ''}><span>${item}</span></label>`).join('')}</div></fieldset><fieldset><legend>常喜欢的地区风味（可多选）</legend><div class="choice-cloud">${CUISINE_OPTIONS.map((item) => `<label><input type="checkbox" name="cuisineTags" value="${item}" ${(profile.cuisineTags || []).includes(item) ? 'checked' : ''}><span>${item}</span></label>`).join('')}</div></fieldset></section><section class="onboarding-section"><div><span class="step-number">2</span><h2>冰箱温度与生活节奏</h2><small>可以直接采用默认值；提醒也可以稍后再填。</small></div><div class="temperature-setup"><label>冷藏温度<input name="fridgeTemperatureC" type="number" min="0" max="10" step="0.5" value="${profile.fridgeTemperatureC ?? 4}"><span>°C</span><small>常用参考：4°C 或以下</small></label><label>冷冻温度<input name="freezerTemperatureC" type="number" min="-30" max="0" step="1" value="${profile.freezerTemperatureC ?? -18}"><span>°C</span><small>常用参考：−18°C 或以下</small></label></div><p class="temperature-note">请填写冰箱显示或温度计读数。设定值不等于实际温度；储存建议会将这里的温度作为检索条件。</p><div class="onboarding-grid three"><label>每天几顿<select name="mealsPerDay">${[1,2,3,4,5].map((n) => `<option value="${n}" ${Number(profile.mealsPerDay || 3) === n ? 'selected' : ''}>${n} 顿</option>`).join('')}</select></label><label>第一顿<input type="time" name="mealTime1" value="${profile.mealTimes?.[0] || '08:00'}"></label><label>第二顿<input type="time" name="mealTime2" value="${profile.mealTimes?.[1] || '12:30'}"></label><label>第三顿<input type="time" name="mealTime3" value="${profile.mealTimes?.[2] || '19:00'}"></label><label>每日食谱提醒<input type="time" name="planningTime" value="${state.notificationSettings.planningTime}"></label><label>“今天想做”确认<input type="time" name="planConfirmationTime" value="${state.notificationSettings.planConfirmationTime || '21:30'}"></label></div><div class="reminder-consent"><label><input type="checkbox" name="enableReminders" checked> 开启应用内/电脑提醒</label><label><input type="checkbox" name="smsConsent"> 同意将提醒同时发送到已验证手机号</label></div></section><div class="onboarding-actions"><button class="secondary-button" type="submit" data-skip-reminders="true">提醒稍后设置</button><button class="primary-button" type="submit">保存并进入 FreshLoop</button></div></form>${state.notice ? `<div class="toast" role="status">${escapeHtml(state.notice)}</div>` : ''}</main>`;
}

function renderNav(activeTab) {
  const state = store.get();
  const nav = [['inventory', '食材库', 'leaf'], ['recipe', '食谱', 'spark'], ['shopping', '采购', 'cart'], ['profile', '档案', 'user']];
  const shoppingCount = getShoppingItems(state).length;
  return `<nav class="bottom-nav" aria-label="主导航">${nav.map(([id, label, iconName]) => `<button class="nav-item ${activeTab === id ? 'active' : ''}" data-tab="${id}">${icon(iconName)}<span>${label}</span>${id === 'shopping' && shoppingCount ? `<em>${shoppingCount}</em>` : ''}</button>`).join('')}</nav>`;
}

function getFilteredInventory(state) {
  const query = state.inventoryQuery.trim().toLowerCase();
  return sortInventoryByExpiry(state.inventory).filter((item) => {
    const categoryMatch = state.inventoryCategory === 'all' || item.uiCategory === state.inventoryCategory;
    const storageMatch = state.inventoryStorage === 'all' || item.storageLocation === state.inventoryStorage;
    const searchMatch = !query || `${item.name} ${item.storageLocation}`.toLowerCase().includes(query);
    return categoryMatch && storageMatch && searchMatch;
  });
}

function renderInventory(state) {
  const expiring = sortInventoryByExpiry(state.inventory).filter((item) => { const days = daysUntil(item.expiryDate); return days != null && days >= 0 && days <= 3; });
  const expired = state.inventory.filter((item) => (daysUntil(item.expiryDate) ?? 0) < 0);
  const filtered = getFilteredInventory(state);
  const lowStock = state.inventory.filter((item) => item.managementMode === 'approximate_stock' && item.stockPercentage <= 20);
  const storageButtons = ['all', ...STORAGE_VALUES].map((value) => {
    const count = value === 'all' ? state.inventory.length : state.inventory.filter((item) => item.storageLocation === value).length;
    return `<button class="storage-choice ${state.inventoryStorage === value ? 'active' : ''}" data-storage="${value}">${value === 'all' ? '全部' : value}<em>${count}</em></button>`;
  }).join('');
  const categoryTabs = Object.entries(CATEGORY_LABELS).map(([id, label]) => `<button role="tab" aria-selected="${state.inventoryCategory === id}" class="category-tab ${state.inventoryCategory === id ? 'active' : ''}" data-category="${id}">${label}</button>`).join('');
  const rows = filtered.map((item) => renderFoodRow(item, state.inventoryManageMode)).join('') || '<div class="empty-list">没有符合条件的食材</div>';

  return `<section class="inventory-layout">
    <aside class="inventory-rail">
      <div class="rail-heading"><p class="eyebrow">MY KITCHEN</p><h1>食材库</h1><p>看清手边的食材，也为下一顿留一点灵感。</p></div>
      <div class="rail-metrics"><div><strong>${state.inventory.length}</strong><span>库存</span></div><div class="pink"><strong>${expiring.length}</strong><span>三天内</span></div><div><strong>${lowStock.length}</strong><span>待补货</span></div></div>
      <div class="rail-section"><div class="rail-section-title"><span>储存方式</span></div><div class="storage-filter">${storageButtons}</div></div>
      <div class="capture-panel"><strong>一次录入多种食材</strong><p>上传小票或食材合照，识别后先核对清单，再选择储存方式与日期。</p><div class="capture-buttons"><button data-action="upload-receipt">${icon('receipt')} 上传小票</button><button data-action="upload-photo">${icon('upload')} 上传合照</button></div><button class="primary-button full-width" data-action="manual-add">${icon('plus')} 手动添加食材</button></div>
    </aside>
    <section class="inventory-detail">
      <div class="detail-toolbar"><label class="search-box">${icon('search')}<input type="search" data-inventory-search value="${escapeHtml(state.inventoryQuery)}" placeholder="搜索食材名或储存方式"></label><button class="manage-button ${state.inventoryManageMode ? 'active' : ''}" data-action="toggle-manage" aria-label="管理食材">${icon('settings')}</button><button class="add-icon-button" data-action="open-capture" aria-label="添加食材">${icon('plus')}</button></div>
      ${expired.length ? `<div class="expired-summary">${expired.length} 项已过期并保留在列表中，以紫色标记。你可以在管理模式中删除。</div>` : ''}
      <div class="category-tabs" role="tablist">${categoryTabs}</div>
      <div class="culture-disclaimer">“寒、热、凉、温”等表述仅作为传统饮食文化资料，不构成健康或医疗建议。</div>
      <div class="list-heading"><div><h2>${CATEGORY_LABELS[state.inventoryCategory]}</h2><span data-inventory-count>${filtered.length} 项</span></div><p><i class="tone-dot pink"></i>0–3 天 <i class="tone-dot blue"></i>4–6 天 <i class="tone-dot green"></i>6 天以上 <i class="tone-dot purple"></i>已过期</p></div>
      <div class="food-list" data-inventory-results>${rows}</div>
      <p class="safety-line">日期来自包装信息或资料检索，只是最佳品质提醒，不等同于食品安全判定；包装说明、实际温度和食材状态始终优先。</p>
    </section>
  </section>`;
}

function renderUrgentItem(item) {
  return `<button class="urgent-item" data-search-item="${escapeHtml(item.name)}"><span class="food-symbol">${ingredientIcon(item.name)}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(expiryLabel(item) || '')}</small></span><i class="urgency-bar ${expiryTone(item)}"></i></button>`;
}

function renderFoodRow(item, manageMode) {
  const expiry = expiryLabel(item);
  const amount = formatStock(item);
  const dateText = item.expiryDate ? new Date(`${item.expiryDate}T12:00:00`).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
  const tone = expiryTone(item);
  const packageStateText = item.packageState === 'opened' ? ' · 已开封' : item.packageState === 'sealed' ? ' · 未开封' : '';
  const controls = manageMode
    ? `<div class="row-manage-actions"><button data-action="edit-item" data-id="${item.id}" aria-label="编辑${escapeHtml(item.name)}">编辑</button><button class="row-delete" data-action="delete-item" data-id="${item.id}" aria-label="删除${escapeHtml(item.name)}">${icon('trash')}</button></div>`
    : `<button class="row-more" data-action="edit-item" data-id="${item.id}" aria-label="查看或编辑${escapeHtml(item.name)}">›</button>`;
  return `<article class="food-row ${tone}-row"><div class="food-symbol large">${ingredientIcon(item.name)}</div><div class="food-copy"><div class="food-name-line"><h3>${escapeHtml(item.name)}</h3>${expiry ? `<span class="expiry-pill ${tone}">${escapeHtml(expiry)}</span>` : item.stockPercentage <= 20 ? '<span class="expiry-pill pink">建议补货</span>' : ''}</div><p>${escapeHtml(item.category)} · ${escapeHtml(item.storageLocation)}${packageStateText}${dateText ? ` · 品质提醒 ${dateText}` : ''}</p><div class="food-hover-note"><span>${escapeHtml(item.story || '')}</span><span>${escapeHtml(item.nature || '')} · ${escapeHtml(item.cooking || '')}</span></div></div><div class="food-amount"><strong class="${item.managementMode === 'freshness_only' ? 'no-quantity' : ''}">${escapeHtml(amount)}</strong><small>${item.managementMode === 'approximate_stock' ? '大致库存' : item.managementMode === 'freshness_only' ? '用完即删' : '已记录'}</small></div>${controls}</article>`;
}

function renderRecipe(state) {
  if (state.recipeMode === 'diy') return renderDiyPlanner(state);
  if (state.recipeMode === 'options') return renderRecipeOptions(state);
  if (state.recipeMode === 'detail') return renderRecipeDetailPage(state);
  if (state.recipeMode === 'favorites') return renderFavoriteRecipes(state);
  return renderRecommendationFeed(state);
}

function recipePageHeader(title, copy, left = '', right = '') {
  return `<section class="recipe-heading"><div class="recipe-heading-side">${left}</div><div><p class="eyebrow">TODAY'S TABLE</p><h1>${title}</h1><p>${copy}</p></div><div class="recipe-heading-side right">${right}</div></section>`;
}

function renderRecommendationFeed(state) {
  const cards = state.dailyRecommendations;
  const header = recipePageHeader('今日推荐', '从现有库存出发，也允许一点新鲜灵感；过敏与明确忌口始终是硬约束。', `<button class="round-label-button" data-action="open-diy">${icon('wand')}<span>此刻想法</span></button>`, `<button class="round-label-button" data-action="open-favorites">${icon('star')}<span>收藏夹</span></button>`);
  const error = state.dailyRecommendationError ? `<div class="ai-connection-panel"><div><strong>没有用模板冒充 AI 结果</strong><p>${escapeHtml(state.dailyRecommendationError)}</p><small>配置服务后点击“重新连接并生成”，才会出现新菜谱。</small></div><button class="primary-button" data-action="refresh-feed">重新连接并生成</button></div>` : '';
  const content = cards.length ? `<div class="rag-status">${icon('spark')} DeepSeek 动态生成 · 结合本次库存抽样、口味画像与 ${cards[0]?.retrievalContext?.length || 0} 条烹饪知识卡</div><section class="recipe-feed">${cards.map((recipe, index) => renderFeedCard(recipe, state, index)).join('')}</section>` : state.isGenerating ? `<div class="feed-loading"><span class="spinner"></span><strong>正在检索资料并现场生成</strong><small>通常需要 15–40 秒；超过 65 秒会自动停止，不会无限等待。</small><button class="secondary-button" data-action="cancel-generation">取消本次生成</button></div>` : '';
  return `${header}<div class="feed-toolbar"><span>为 ${escapeHtml(state.profile.name)} 生成 · ${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span><button data-action="refresh-feed">${icon('refresh')} ${state.isGenerating ? '更新中…' : '换一组'}</button></div>${error}${content}`;
}

function planStatusText(plan) {
  if (!plan) return '';
  if (plan.status === 'awaiting_review') return '已确认做过 · 等待核对实际用量，库存尚未扣减';
  return `已加入今日计划 · ${plan.confirmationTime || '21:30'} 后确认，当前只影响采购清单`;
}

function renderFeedCard(recipe, state, index) {
  const missing = buildShoppingList(recipe, state.inventory);
  const favorite = state.favorites.includes(recipe.id);
  const planned = state.plannedMeals.find((item) => String(item.recipeId) === String(recipe.id) && ['planned', 'awaiting_review'].includes(item.status));
  const used = recipePreviewIngredients(recipe, state, 4);
  return `<article class="feed-card ${index === 0 ? 'feature' : ''}" data-recipe-card="${recipe.id}" tabindex="0" aria-label="打开${escapeHtml(recipe.recipeName)}完整做法"><div class="recipe-visual"><img src="${recipeImage(recipe)}" alt="${escapeHtml(recipe.recipeName)}成品参考图" referrerpolicy="no-referrer">${recipe.image?.sourceUrl ? `<a class="image-attribution" href="${safeSourceUrl(recipe.image.sourceUrl)}" target="_blank" rel="noreferrer" data-card-control>图片：${escapeHtml(recipe.image.provider || recipe.image.license || '开放图库')}</a>` : ''}<small>${formatPrepTime(recipe.estimatedPrepMinutes)} · ${recipe.servings} 人份</small></div><div class="feed-card-copy"><div class="feed-card-top"><span>${escapeHtml(recipe.planLabel || (index < 2 ? '尽量用现有库存' : '少量补齐新食材'))}</span><button class="star-button ${favorite ? 'saved' : ''}" data-action="favorite-recipe" data-id="${recipe.id}" aria-label="${favorite ? '取消收藏' : '收藏'}">${icon('star')}</button></div><h2>${escapeHtml(recipe.recipeName)}</h2><p>${escapeHtml(recipe.reason)}</p><div class="ingredient-preview">${used.map((item) => `<span>${ingredientIcon(item.name)} ${escapeHtml(item.name)}</span>`).join('')}</div><div class="feed-meta"><span>${missing.length ? `${missing.length} 项需要采购或确认` : '家中食材已够用'} · 核心食材 ${recipe.coreIngredientCount ?? '≤3'} 种</span></div>${planned ? `<small class="plan-status">${escapeHtml(planStatusText(planned))}</small>` : ''}<div class="feed-actions"><button class="secondary-button" data-action="favorite-recipe" data-id="${recipe.id}">${icon('star')} ${favorite ? '已收藏' : '先收藏'}</button><button class="primary-button ${planned ? 'planned-button' : ''}" data-action="want-recipe" data-id="${recipe.id}">${icon('leaf')} ${planned ? '取消今日计划' : '今天想做'}</button></div></div></article>`;
}

function recipePreviewIngredients(recipe, state, limit = 6) {
  const items = recipe.ingredients || [];
  const requiredByIntent = items.filter((item) => item.userIntentRequired);
  const inStock = items.filter((item) => !item.userIntentRequired && findInventoryItem(state.inventory, item.canonicalName));
  const remaining = items.filter((item) => !requiredByIntent.includes(item) && !inStock.includes(item));
  return [...requiredByIntent, ...inStock, ...remaining].slice(0, limit);
}

function formatPrepTime(minutes) {
  const value = Number(minutes || 0);
  if (value > 120) return '2 小时以上';
  if (value === 120) return '约 2 小时';
  if (value >= 60) return `${Math.floor(value / 60)} 小时${value % 60 ? ` ${value % 60} 分钟` : ''}`;
  return `${value} 分钟`;
}

function recipeStepList(value, fallback = []) {
  const text = (item) => {
    if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
    if (item && typeof item === 'object') return Object.values(item).filter((part) => typeof part === 'string' || typeof part === 'number').map(String).join(' · ').trim();
    return '';
  };
  if (Array.isArray(value)) {
    const normalized = value.map(text).filter((item) => item && item !== '[object Object]');
    return normalized.length ? normalized : fallback;
  }
  if (typeof value === 'string') return value.split(/\n+|(?=\d+[.、）)])/).map((item) => item.replace(/^\d+[.、）)]\s*/, '').trim()).filter(Boolean);
  return fallback;
}

function renderDiyPlanner(state) {
  const input = state.planningInput;
  const cookingInventory = recipeSelectableInventory(state.inventory);
  const priority = sortInventoryByExpiry(cookingInventory).filter((item) => item.expiryDate && daysUntil(item.expiryDate) >= 0).slice(0, 5);
  const staples = state.inventory.filter((item) => item.uiCategory === 'staple').map((item) => ({ ...item, icon: ingredientIcon(item.name) }));
  const others = cookingInventory.filter((item) => !priority.some((entry) => entry.id === item.id));
  const condiments = condimentInventory(state.inventory).map((item) => ({ ...item, icon: ingredientIcon(item.name) }));
  const header = recipePageHeader('照此刻的想法来', '此刻明确说出的味道和菜式优先于库存便利，但绝不会越过过敏与明确忌口。', `<button class="back-button" data-action="back-to-feed">${icon('back')} 返回推荐</button>`);
  return `${header}<form class="diy-card" data-form="planner"><label class="field-label">今天想吃什么？<textarea name="prompt" placeholder="例如：要真正有辣椒的香辣口味、想吃云南风味、想慢炖牛肉……" required>${escapeHtml(input.prompt)}</textarea><small class="hard-intent-note">你明确写出的味道和菜式会作为硬标准；即使库存没有辣椒，也会照样生成真正有辣椒的菜。</small></label><div class="form-grid three"><label class="field-label">人数<select name="servings">${[1,2,3,4].map((n) => `<option value="${n}" ${input.servings === n ? 'selected' : ''}>${n} 人</option>`).join('')}</select></label><label class="field-label">备餐时间<select name="prepTime"><option value="15" ${input.prepTime === 15 ? 'selected' : ''}>≤15 分钟</option><option value="30" ${input.prepTime === 30 ? 'selected' : ''}>15–30 分钟</option><option value="45" ${input.prepTime === 45 ? 'selected' : ''}>30–45 分钟</option><option value="60" ${input.prepTime === 60 ? 'selected' : ''}>45–60 分钟</option><option value="120" ${input.prepTime === 120 ? 'selected' : ''}>1–2 小时</option><option value="240" ${input.prepTime === 240 ? 'selected' : ''}>2 小时以上（炖煮）</option></select></label><label class="field-label">主食选择<select name="carbId"><option value="">这顿不一定要主食</option>${staples.map((item) => `<option value="${item.id}" ${input.carbId === item.id ? 'selected' : ''}>${item.icon || ingredientIcon(item.name)} ${escapeHtml(item.name)}</option>`).join('')}</select></label></div><div class="planner-policy"><div><strong>四个方案怎样分配</strong><p>2 道尽量使用现有核心食材，2 道允许少量补齐；每道菜最多 3 种核心食材。</p></div><div><strong>调味料默认从家里选</strong><p>整组最多只有 1 道菜缺 1 种调味料；点名菜式确实需要时才例外。</p><span>${condiments.map((item) => `${item.icon || ingredientIcon(item.name)} ${escapeHtml(item.name)}`).join(' · ') || '尚未记录调味库存'}</span></div></div><div class="field-label priority-label">优先使用<span>只展示适合入菜的肉蛋、豆制品、蔬菜和水果</span></div><div class="priority-picker">${priority.map((item) => renderIngredientCheck(item, input, true)).join('')}</div><details class="other-inventory"><summary>展开其他可入菜库存（${others.length} 项）</summary><div class="priority-picker">${others.map((item) => renderIngredientCheck(item, input, false)).join('')}</div></details><button class="primary-button full-width large-action" type="submit" ${state.isGenerating ? 'disabled' : ''}>${state.isGenerating ? '<span class="spinner light"></span> 正在构思 4 道菜' : `${icon('spark')} 给我 4 个选择`}</button></form>`;
}

function renderIngredientCheck(item, input, showExpiry) {
  return `<label class="check-pill"><input type="checkbox" name="priority" value="${item.id}" ${input.selectedIngredientIds.includes(item.id) ? 'checked' : ''}><span>${ingredientIcon(item.name)} ${escapeHtml(item.name)}${showExpiry ? `<small>${escapeHtml(expiryLabel(item) || '')}</small>` : ''}</span></label>`;
}

function renderRecipeOptions(state) {
  const header = recipePageHeader('这几道，你更想做哪一道？', '每一道都重新核对了口味、时间、库存和硬约束；选中后，缺的食材才会加入采购。', `<button class="back-button" data-action="open-diy">${icon('back')} 修改想法</button>`);
  return `${header}<section class="option-grid">${state.recipes.slice(-4).map((recipe) => renderOptionCard(recipe, state)).join('')}</section><form class="follow-up-box" data-form="follow-up"><label>还想往哪个方向调整？<input name="followUp" placeholder="例如：再辣一点、不要汤、把鸡肉换成豆腐……" required></label><button class="secondary-button" type="submit">继续调整</button></form>`;
}

function renderOptionCard(recipe, state) {
  const missing = buildShoppingList(recipe, state.inventory);
  const favorite = state.favorites.includes(recipe.id);
  const planned = state.plannedMeals.find((item) => String(item.recipeId) === String(recipe.id) && ['planned', 'awaiting_review'].includes(item.status));
  return `<article class="option-card" data-recipe-card="${recipe.id}" tabindex="0" aria-label="打开${escapeHtml(recipe.recipeName)}完整做法"><div class="option-title"><img src="${recipeImage(recipe)}" alt="${escapeHtml(recipe.recipeName)}" referrerpolicy="no-referrer"><div><small>${escapeHtml(recipe.planLabel || '按库存与想法生成')} · ${formatPrepTime(recipe.estimatedPrepMinutes)} · ${recipe.servings} 人份</small><h2>${escapeHtml(recipe.recipeName)}</h2></div><button class="star-button ${favorite ? 'saved' : ''}" data-action="favorite-recipe" data-id="${recipe.id}">${icon('star')}</button></div><p>${escapeHtml(recipe.reason)}</p><div class="mini-ingredients">${recipePreviewIngredients(recipe, state).map((item) => `<span class="${item.userIntentRequired ? 'intent-required' : ''}">${escapeHtml(item.name)}</span>`).join('')}</div><small class="option-gap">${missing.length ? `需要补充或确认 ${missing.length} 项` : '现有库存可以完成'}</small>${planned ? `<small class="plan-status">${escapeHtml(planStatusText(planned))}</small>` : ''}<div class="feed-actions"><button class="primary-button ${planned ? 'planned-button' : ''}" data-action="want-recipe" data-id="${recipe.id}">${planned ? '取消今日计划' : '今天想做'}</button></div></article>`;
}

function findRecipe(state, id) {
  return [...state.dailyRecommendations, ...state.recipes].find((recipe) => String(recipe.id) === String(id));
}

function renderRecipeDetailPage(state) {
  const recipe = findRecipe(state, state.selectedRecipeId);
  if (!recipe) return renderRecommendationFeed(state);
  const errors = validateRecipe(recipe, state.inventory, state.profile);
  const missing = buildShoppingList(recipe, state.inventory);
  const favorite = state.favorites.includes(recipe.id);
  const planned = state.plannedMeals.find((item) => String(item.recipeId) === String(recipe.id) && ['planned', 'awaiting_review'].includes(item.status));
  const backMode = state.recipeReturnMode === 'options' ? 'back-to-options' : 'back-to-feed';
  const header = recipePageHeader(recipe.recipeName, recipe.reason, `<button class="back-button" data-action="${backMode}">${icon('back')} 返回</button>`, `<button class="star-button large ${favorite ? 'saved' : ''}" data-action="favorite-recipe" data-id="${recipe.id}">${icon('star')}</button>`);
  const gapNotice = missing.length
    ? `<div class="shopping-gap-button">${icon('cart')} ${missing.length} 项需要购买或确认 <span>${planned ? '已加入采购清单' : '选择“今天想做”后加入采购 →'}</span></div>`
    : '<div class="all-set">家中食材已足够完成这道菜</div>';
  return `${header}<article class="recipe-detail-card">
    <img class="recipe-detail-hero" src="${recipeImage(recipe)}" alt="${escapeHtml(recipe.recipeName)}成品参考图" referrerpolicy="no-referrer">
    <div class="detail-summary"><div><p class="eyebrow">${formatPrepTime(recipe.estimatedPrepMinutes)} · ${recipe.servings} 人份 · 核心食材 ${recipe.coreIngredientCount ?? '≤3'} 种</p><h2>从多少油、什么火候开始，一步一步做</h2></div><span class="validated-badge ${errors.length ? 'warn' : ''}">${errors.length ? '需要调整' : '约束已检查'}</span></div>
    ${errors.length ? `<div class="alert danger-alert">${errors.map(escapeHtml).join('；')}</div>` : ''}
    <div class="recipe-detail-grid"><section><h3>食材与调味</h3><div class="recipe-ingredients">${recipe.ingredients.map((item) => { const current = findInventoryItem(state.inventory, item.canonicalName); return `<div><span>${escapeHtml(item.name)}${!current ? '<em>需购买</em>' : ''}</span><strong>${escapeHtml(String(item.requiredAmount))} ${escapeHtml(item.unit)}</strong></div>`; }).join('')}</div><h3>处理准备</h3><ul class="detail-list">${(recipe.prep || ['清洗并按步骤切配食材。']).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ul></section><section><h3>烹饪时间线</h3><ol class="steps detailed">${recipe.steps.map((step) => `<li><span>${escapeHtml(step)}</span></li>`).join('')}</ol>${recipe.tips?.length ? `<div class="cook-tips"><strong>不翻车小贴士</strong>${recipe.tips.map((tip) => `<p>${escapeHtml(tip)}</p>`).join('')}</div>` : ''}</section></div>
    ${gapNotice}${planned ? `<small class="plan-status detail-plan-status">${escapeHtml(planStatusText(planned))}</small>` : ''}
    <div class="recipe-actions"><button class="secondary-button" data-action="favorite-recipe" data-id="${recipe.id}">${icon('star')} ${favorite ? '已收藏' : '先收藏'}</button><button class="primary-button ${planned ? 'planned-button' : ''}" data-action="want-recipe" data-id="${recipe.id}">${icon('leaf')} ${planned ? '取消今日计划' : '今天想做'}</button><button class="secondary-button" data-action="${backMode}">${icon('back')} 返回推荐</button></div>
  </article>`;
}

function renderFavoriteRecipes(state) {
  const all = [...state.dailyRecommendations, ...state.recipes];
  const favorites = all.filter((recipe, index) => state.favorites.includes(recipe.id) && all.findIndex((entry) => entry.id === recipe.id) === index);
  const header = recipePageHeader('收藏夹', '喜欢的灵感先留在这里，想做时再把缺少的食材放进采购清单。', `<button class="back-button" data-action="back-to-feed">${icon('back')} 返回推荐</button>`);
  return `${header}${favorites.length ? `<section class="option-grid">${favorites.map((recipe) => renderOptionCard(recipe, state)).join('')}</section>` : '<div class="empty-list tall">还没有收藏。点亮一颗星，它就会留在这里。</div>'}`;
}

function normalizeEssentialItems(profile) {
  return (profile.essentialItems || []).map((item) => typeof item === 'string' ? { name: item, threshold: 20 } : item);
}

function getShoppingItems(state) {
  const dismissed = new Set(state.shoppingDismissed || []);
  const map = new Map();
  state.shoppingItems.filter((item) => item.status !== 'purchased' && !dismissed.has(item.name)).forEach((item) => map.set(item.name, { ...item }));
  normalizeEssentialItems(state.profile).forEach(({ name, threshold }) => {
    if (dismissed.has(name)) return;
    const inventoryItem = state.inventory.find((item) => item.name === name);
    const needsRefill = !inventoryItem || (inventoryItem.managementMode === 'approximate_stock' && inventoryItem.stockPercentage <= threshold);
    if (needsRefill && !map.has(name)) map.set(name, { name, canonicalName: inventoryItem?.canonicalName || name, requiredAmount: 1, unit: '份', status: 'to_buy', reason: inventoryItem ? `必备食材仅剩约 ${inventoryItem.stockPercentage}%（阈值 ${threshold}%）` : '必备食材当前无库存', source: 'essential' });
  });
  return [...map.values()];
}

function renderShopping(state) {
  const items = getShoppingItems(state);
  return `<section class="simple-page-heading shopping-heading"><div><p class="eyebrow">SHOPPING</p><h1>采购清单</h1><p>菜谱缺口和必备食材提醒合在一起；勾选后会划线、变淡并自动收起。</p></div><span class="shopping-total">${items.length}<small>待处理</small></span></section><div class="shopping-layout"><section class="shopping-main"><div class="shopping-list-head"><h2>需要购买</h2><span>${items.length} 项</span></div>${items.length ? `<div class="clean-shopping-list">${items.map((item) => `<label class="clean-shopping-item" data-shopping-row="${escapeHtml(item.name)}"><input type="checkbox" data-shopping-name="${escapeHtml(item.name)}"><span class="food-symbol">${ingredientIcon(item.name)}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.reason || '手动添加')}</small></span><em>${item.requiredAmount ? `${escapeHtml(String(item.requiredAmount))} ${escapeHtml(item.unit || '')}` : ''}</em></label>`).join('')}</div>` : '<div class="empty-list tall">采购清单是空的，手边的食材很安心。</div>'}<form class="shopping-add-form" data-form="shopping-add"><input name="name" placeholder="添加其他要买的食材" required><button class="primary-button" type="submit">${icon('plus')} 添加</button></form></section><aside class="essential-card"><p class="eyebrow">ESSENTIALS</p><h3>你的必备食材</h3><p>每种食材都有自己的低库存阈值，可在档案里单独调整。</p><div class="essential-cloud">${normalizeEssentialItems(state.profile).map((item) => `<span>${escapeHtml(item.name)}<small>≤${item.threshold}%</small></span>`).join('')}</div><button class="text-button" data-tab="profile">去档案调整 →</button></aside></div>`;
}

function renderProfile(state) {
  const profile = state.profile;
  const settings = state.notificationSettings;
  const essentials = normalizeEssentialItems(profile);
  const times = [...(profile.mealTimes || [])].slice(0, Number(profile.mealsPerDay || 3));
  while (times.length < Number(profile.mealsPerDay || 3)) times.push('12:00');
  return `<section class="simple-page-heading"><div><p class="eyebrow">PROFILE & REMINDERS</p><h1>偏好与提醒</h1><p>把饮食习惯和提醒节奏设成适合自己的样子，之后随时都能改。</p></div><div class="avatar">${escapeHtml(profile.name.slice(0, 1))}</div></section><div class="profile-layout"><section class="profile-card"><div class="profile-intro"><div class="avatar large">${escapeHtml(profile.name.slice(0, 1))}</div><div><h2>${escapeHtml(profile.name)}</h2><p>过敏与明确忌口会在每次生成后再次检查</p></div></div><div class="profile-section"><div class="section-title"><h3>过敏与明确忌口</h3><span class="hard-badge">不可违反</span></div><div class="editable-tags constraint-tags">${(profile.allergies || []).map((tag) => `<span class="danger-tag">${escapeHtml(tag)}过敏<button data-action="remove-constraint" data-kind="allergies" data-name="${escapeHtml(tag)}">×</button></span>`).join('')}${(profile.dislikes || []).map((tag) => `<span>${escapeHtml(tag)}（不喜欢）<button data-action="remove-constraint" data-kind="dislikes" data-name="${escapeHtml(tag)}">×</button></span>`).join('')}</div><form class="inline-form" data-form="constraint-add"><select name="kind"><option value="allergies">过敏</option><option value="dislikes">不喜欢</option></select><input name="name" placeholder="输入食材" required><button type="submit">添加</button></form></div><div class="profile-section"><h3>必备食材清单</h3><p class="section-copy">每种食材单独设置低于多少库存时提醒采购。</p><div class="essential-editor">${essentials.map((item) => `<div><span>${escapeHtml(item.name)}</span><label>低于 <input type="number" min="1" max="100" value="${item.threshold}" data-essential-threshold="${escapeHtml(item.name)}"> %</label><button data-action="remove-essential" data-name="${escapeHtml(item.name)}">${icon('trash')}</button></div>`).join('')}</div><form class="essential-add" data-form="essential-add"><input name="name" placeholder="例如：盐、面条" required><input name="threshold" type="number" min="1" max="100" value="20" aria-label="提醒百分比"><button type="submit">添加</button></form></div><div class="profile-section"><div class="section-title"><h3>规律用餐</h3><label class="meal-count">每天 <select data-profile="mealsPerDay">${[1,2,3,4,5].map((n) => `<option value="${n}" ${Number(profile.mealsPerDay) === n ? 'selected' : ''}>${n}</option>`).join('')}</select> 顿</label></div><div class="meal-times">${times.map((time, index) => `<label>第 ${index + 1} 顿<input type="time" value="${time}" data-meal-time="${index}"></label>`).join('')}</div></div></section><section class="profile-card"><div class="section-title"><div><p class="eyebrow">NOTIFICATIONS</p><h3>电脑通知</h3></div><button class="notification-toggle ${settings.enabled ? 'on' : ''}" data-action="enable-notifications">${settings.enabled ? '已开启' : '开启通知'}</button></div><div class="settings-list"><label><span><strong>临期食材提醒</strong><small>到期前几天开始提醒</small></span><span class="setting-inline"><input type="checkbox" data-setting="expiry" ${settings.expiry ? 'checked' : ''}><input type="number" min="1" max="30" data-setting="expiryDaysBefore" value="${settings.expiryDaysBefore}"><em>天前</em></span></label><label><span><strong>每日食谱规划</strong><small>在同一处开启并选择规划时间</small></span><span class="setting-inline"><input type="checkbox" data-setting="dailyRecipe" ${settings.dailyRecipe ? 'checked' : ''}><input type="time" data-setting="planningTime" value="${escapeHtml(settings.planningTime)}"></span></label><label class="stack-setting"><span><strong>餐后消耗确认</strong><small>选择最适合你的记录方式</small></span><select data-setting="mealReviewMode"><option value="after_meal" ${settings.mealReviewMode === 'after_meal' ? 'selected' : ''}>每餐饭后提醒</option><option value="fixed_time" ${settings.mealReviewMode === 'fixed_time' ? 'selected' : ''}>每天固定时间</option><option value="none" ${settings.mealReviewMode === 'none' ? 'selected' : ''}>不记录用量，用完手动删除</option></select></label>${settings.mealReviewMode === 'after_meal' ? `<label><span><strong>饭后多久提醒</strong><small>按上方每顿用餐时间自动顺延</small></span><span class="setting-inline"><input type="number" min="0" max="6" step="0.5" data-setting="afterMealHours" value="${settings.afterMealHours}"><em>小时</em></span></label>` : ''}${settings.mealReviewMode === 'fixed_time' ? `<label><span><strong>固定提醒时间</strong><small>集中核对当天消耗</small></span><input type="time" data-setting="fixedReviewTime" value="${escapeHtml(settings.fixedReviewTime)}"></label>` : ''}</div>${state.pendingMealReviews.length ? `<div class="pending-review"><strong>${state.pendingMealReviews.length} 顿饭等待确认</strong><button data-action="review-pending">现在确认</button></div>` : ''}</section></div><button class="reset-link" data-action="reset-demo">${icon('refresh')} 重置演示数据</button>`;
}

function renderProfileV4(state) {
  const profile = state.profile; const settings = state.notificationSettings; const essentials = normalizeEssentialItems(profile);
  const times = [...(profile.mealTimes || [])].slice(0, Number(profile.mealsPerDay || 3)); while (times.length < Number(profile.mealsPerDay || 3)) times.push('12:00');
  return `<section class="simple-page-heading"><div><p class="eyebrow">PROFILE & REMINDERS</p><h1>偏好与提醒</h1><p>你的口味、冰箱实际温度和提醒节奏都会参与推荐；这里的设置之后随时能改。</p></div><div class="avatar">${escapeHtml((profile.name || 'U').slice(0, 1))}</div></section><div class="profile-layout"><section class="profile-card"><div class="profile-intro"><div class="avatar large">${escapeHtml((profile.name || 'U').slice(0, 1))}</div><div><h2>${escapeHtml(profile.name)}</h2><p>${escapeHtml(profile.phone || '手机号未同步')} · 过敏与忌口是不可违反的硬约束</p></div></div><div class="profile-section"><div class="section-title"><h3>过敏与明确忌口</h3><span class="hard-badge">不可违反</span></div><div class="editable-tags constraint-tags">${(profile.allergies || []).map((tag) => `<span class="danger-tag">${escapeHtml(tag)}过敏<button data-action="remove-constraint" data-kind="allergies" data-name="${escapeHtml(tag)}">×</button></span>`).join('')}${(profile.dislikes || []).map((tag) => `<span>${escapeHtml(tag)}（不喜欢）<button data-action="remove-constraint" data-kind="dislikes" data-name="${escapeHtml(tag)}">×</button></span>`).join('')}</div><form class="inline-form" data-form="constraint-add"><select name="kind"><option value="allergies">过敏</option><option value="dislikes">不喜欢</option></select><input name="name" placeholder="输入食材" required><button type="submit">添加</button></form></div><div class="profile-section"><h3>口味画像</h3><p class="taste-summary">${escapeHtml(profile.tasteProfileSummary || '还没有形成口味画像')}</p><span class="profile-field-title">喜欢的味道</span><div class="choice-cloud compact">${TASTE_OPTIONS.map((item) => `<label><input type="checkbox" data-profile-tag="tasteTags" value="${item}" ${(profile.tasteTags || []).includes(item) ? 'checked' : ''}><span>${item}</span></label>`).join('')}</div><span class="profile-field-title">地区风味</span><div class="choice-cloud compact">${CUISINE_OPTIONS.map((item) => `<label><input type="checkbox" data-profile-tag="cuisineTags" value="${item}" ${(profile.cuisineTags || []).includes(item) ? 'checked' : ''}><span>${item}</span></label>`).join('')}</div><label class="profile-notes">更多偏好<textarea data-profile-text="tasteNotes" placeholder="例如：喜欢微辣、有锅气、不要太油">${escapeHtml(profile.tasteNotes || '')}</textarea></label></div><div class="profile-section"><h3>冰箱温度</h3><p class="section-copy">请以冰箱显示或温度计实测为准；生成储存建议时会带上这两个条件。</p><div class="temperature-setup compact"><label>冷藏<input type="number" min="0" max="10" step="0.5" value="${profile.fridgeTemperatureC ?? 4}" data-profile-temp="fridgeTemperatureC"><span>°C</span><small>常用参考 ≤4°C</small></label><label>冷冻<input type="number" min="-30" max="0" step="1" value="${profile.freezerTemperatureC ?? -18}" data-profile-temp="freezerTemperatureC"><span>°C</span><small>常用参考 ≤−18°C</small></label></div></div><div class="profile-section"><h3>必备食材清单</h3><p class="section-copy">每种食材单独设置低于多少库存时提醒采购。</p><div class="essential-editor">${essentials.map((item) => `<div><span>${escapeHtml(item.name)}</span><label>低于 <input type="number" min="1" max="100" value="${item.threshold}" data-essential-threshold="${escapeHtml(item.name)}"> %</label><button data-action="remove-essential" data-name="${escapeHtml(item.name)}">${icon('trash')}</button></div>`).join('')}</div><form class="essential-add" data-form="essential-add"><input name="name" placeholder="例如：盐、面条" required><input name="threshold" type="number" min="1" max="100" value="20" aria-label="提醒百分比"><button type="submit">添加</button></form></div></section><section class="profile-card"><div class="section-title"><div><p class="eyebrow">NOTIFICATIONS</p><h3>提醒方式</h3></div><button class="notification-toggle ${settings.enabled ? 'on' : ''}" data-action="enable-notifications">${settings.enabled ? '已开启' : '开启通知'}</button></div><div class="settings-list"><label><span><strong>通知通道</strong><small>短信只发到已验证手机号 ${escapeHtml(profile.phone || '')}</small></span><select data-setting="channel"><option value="app" ${settings.channel === 'app' ? 'selected' : ''}>仅应用内/电脑</option><option value="sms" ${settings.channel === 'sms' ? 'selected' : ''}>仅短信</option><option value="both" ${settings.channel === 'both' ? 'selected' : ''}>应用内 + 短信</option></select></label><label><span><strong>允许短信提醒</strong><small>可随时关闭，不用于营销</small></span><input type="checkbox" data-setting="smsConsent" ${settings.smsConsent ? 'checked' : ''}></label><label><span><strong>临期食材提醒</strong><small>到期前几天开始提醒</small></span><span class="setting-inline"><input type="checkbox" data-setting="expiry" ${settings.expiry ? 'checked' : ''}><input type="number" min="1" max="30" data-setting="expiryDaysBefore" value="${settings.expiryDaysBefore}"><em>天前</em></span></label><label><span><strong>每日食谱规划</strong><small>开启并选择每天查看推荐的时间</small></span><span class="setting-inline"><input type="checkbox" data-setting="dailyRecipe" ${settings.dailyRecipe ? 'checked' : ''}><input type="time" data-setting="planningTime" value="${escapeHtml(settings.planningTime)}"></span></label><label><span><strong>“今天想做”确认</strong><small>到点后询问这道菜实际做了没有</small></span><input type="time" data-setting="planConfirmationTime" value="${escapeHtml(settings.planConfirmationTime || '21:30')}"></label><label class="stack-setting"><span><strong>做完后的消耗记录</strong><small>只有确认做了才会进入用量核对</small></span><select data-setting="mealReviewMode"><option value="after_meal" ${settings.mealReviewMode === 'after_meal' ? 'selected' : ''}>确认做了后立即核对</option><option value="fixed_time" ${settings.mealReviewMode === 'fixed_time' ? 'selected' : ''}>每天固定时间集中核对</option><option value="none" ${settings.mealReviewMode === 'none' ? 'selected' : ''}>不记录用量，用完手动删除</option></select></label>${settings.mealReviewMode === 'fixed_time' ? `<label><span><strong>集中核对时间</strong><small>处理当天等待确认的用量</small></span><input type="time" data-setting="fixedReviewTime" value="${escapeHtml(settings.fixedReviewTime)}"></label>` : ''}</div><div class="profile-section"><div class="section-title"><h3>规律用餐</h3><label class="meal-count">每天 <select data-profile="mealsPerDay">${[1,2,3,4,5].map((n) => `<option value="${n}" ${Number(profile.mealsPerDay) === n ? 'selected' : ''}>${n}</option>`).join('')}</select> 顿</label></div><div class="meal-times">${times.map((time, index) => `<label>第 ${index + 1} 顿<input type="time" value="${time}" data-meal-time="${index}"></label>`).join('')}</div></div>${state.plannedMeals.some((item) => item.status === 'planned') ? `<div class="pending-review"><strong>${state.plannedMeals.filter((item) => item.status === 'planned').length} 道“今天想做”等待晚间确认</strong><button data-action="check-plan-now">现在确认</button></div>` : ''}</section></div><button class="reset-link" data-action="reset-demo">${icon('refresh')} 重置演示数据</button>`;
}

function cleanList(value) {
  return String(value || '').split(/[、,，;；\n]/).map((item) => item.trim()).filter((item) => item && item !== '无' && item !== '没有');
}

function blankOnboardingProfile(phone) {
  return {
    name: '',
    phone,
    allergies: [],
    dislikes: [],
    preferences: [],
    tasteTags: [],
    cuisineTags: [],
    tasteNotes: '',
    tasteProfileSummary: '',
    mealsPerDay: 3,
    mealTimes: ['08:00', '12:30', '19:00'],
    fridgeTemperatureC: 4,
    freezerTemperatureC: -18,
    onboardingComplete: false
  };
}

function applyRemoteProfile(remote, phone) {
  const schedule = remote?.meal_schedule || {};
  const temperatures = remote?.appliance_temperatures || {};
  return {
    name: remote?.display_name || '',
    phone: remote?.phone || phone,
    allergies: remote?.allergies || [],
    dislikes: remote?.dislikes || [],
    preferences: remote?.preferences || [],
    tasteTags: remote?.taste_tags || [],
    cuisineTags: remote?.cuisine_tags || [],
    tasteNotes: remote?.taste_notes || '',
    tasteProfileSummary: remote?.taste_profile_summary || '',
    mealsPerDay: schedule.mealsPerDay || 3,
    mealTimes: schedule.mealTimes || ['08:00', '12:30', '19:00'],
    fridgeTemperatureC: temperatures.fridgeC ?? 4,
    freezerTemperatureC: temperatures.freezerC ?? -18,
    onboardingComplete: Boolean(remote?.onboarding_completed)
  };
}

function bindAuthEvents() {
  document.querySelector('[data-form="phone-auth"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const phone = new FormData(event.currentTarget).get('phone').replace(/\s+/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) { notify('请输入带国家/地区代码的手机号，例如 +6581234567'); return; }
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '正在发送…';
    try { const result = await requestPhoneOtp(phone); store.update((next) => { next.auth.phone = phone; next.auth.stage = 'otp'; }); if (result.demo) notify(result.message); }
    catch (error) { button.disabled = false; button.textContent = '获取短信验证码'; notify(error.message); }
  });
  document.querySelector('[data-form="verify-otp"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get('token').trim();
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '正在验证…';
    try {
      const session = await verifyPhoneOtp(store.get().auth.phone, token);
      const remote = await loadRemoteProfile(session).catch(() => null);
      store.update((next) => {
        next.auth.authenticated = true; next.auth.session = session; next.auth.demoMode = !hasRemoteAuth();
        next.profile = { ...next.profile, ...(remote ? applyRemoteProfile(remote, next.auth.phone) : blankOnboardingProfile(next.auth.phone)) };
        if (remote) { next.notificationSettings = { ...next.notificationSettings, ...(remote.notification_settings || {}), channel: remote.notification_channel || 'app', smsConsent: Boolean(remote.sms_consent) }; }
        next.profile.phone = session.user?.phone || next.auth.phone; next.auth.onboardingComplete = Boolean(remote?.onboarding_completed);
      });
    } catch (error) { button.disabled = false; button.textContent = '验证并继续'; notify(error.message); }
  });
  document.querySelector('[data-action="change-phone"]')?.addEventListener('click', () => store.update((next) => { next.auth.stage = 'phone'; next.auth.phone = ''; }));
  document.querySelector('[data-action="demo-enter"]')?.addEventListener('click', () => store.update((next) => { next.auth = { authenticated: true, onboardingComplete: true, stage: 'phone', phone: '+6581234567', session: { access_token: 'demo', user: { id: 'demo-user', phone: '+6581234567' } }, demoMode: true }; next.profile.onboardingComplete = true; next.profile.phone = '+6581234567'; }));
}

function bindOnboardingEvents() {
  document.querySelector('[data-form="onboarding"]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tastes = form.getAll('tasteTags');
    if (!tastes.length) { notify('请至少选择一种喜欢的味道，之后仍可修改'); return; }
    const skipReminders = event.submitter?.dataset.skipReminders === 'true';
    const allergies = cleanList(form.get('allergies')); const dislikes = cleanList(form.get('dislikes'));
    const mealTimes = [form.get('mealTime1'), form.get('mealTime2'), form.get('mealTime3')].filter(Boolean).slice(0, Number(form.get('mealsPerDay')));
    store.update((next) => {
      Object.assign(next.profile, {
        name: form.get('name').trim(), phone: next.auth.phone, allergies, dislikes, tasteTags: tastes, cuisineTags: form.getAll('cuisineTags'), tasteNotes: form.get('tasteNotes').trim(), mealsPerDay: Number(form.get('mealsPerDay')), mealTimes,
        fridgeTemperatureC: Number(form.get('fridgeTemperatureC')), freezerTemperatureC: Number(form.get('freezerTemperatureC')), onboardingComplete: true
      });
      next.profile.tasteProfileSummary = buildTasteProfile(next.profile);
      next.notificationSettings.enabled = skipReminders ? false : form.get('enableReminders') === 'on';
      next.notificationSettings.dailyRecipe = !skipReminders;
      next.notificationSettings.planningTime = form.get('planningTime') || '21:00';
      next.notificationSettings.planConfirmationTime = form.get('planConfirmationTime') || '21:30';
      next.notificationSettings.smsConsent = !skipReminders && form.get('smsConsent') === 'on';
      next.notificationSettings.channel = next.notificationSettings.smsConsent ? 'both' : 'app';
      next.auth.onboardingComplete = true;
    });
    const current = store.get();
    try { await saveRemoteProfile(current.auth.session, current.profile, current.notificationSettings); notify('饮食画像已建立，之后可在档案随时修改'); }
    catch (error) { notify(`已保存在本机；云端同步待重试：${error.message}`); }
    refreshDailyRecommendations();
  });
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    navigateView({ activeTab: tab });
    if (tab === 'recipe' && !store.get().dailyRecommendations.length && !store.get().isGenerating) refreshDailyRecommendations();
  }));
  document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => store.set({ inventoryCategory: button.dataset.category })));
  document.querySelectorAll('[data-storage]').forEach((button) => button.addEventListener('click', () => store.set({ inventoryStorage: button.dataset.storage })));
  document.querySelector('[data-inventory-search]')?.addEventListener('input', updateInventorySearch);
  document.querySelectorAll('[data-action="open-capture"]').forEach((button) => button.addEventListener('click', openCaptureHub));
  document.querySelectorAll('[data-action="upload-receipt"]').forEach((button) => button.addEventListener('click', () => openUploadRecognition('receipt')));
  document.querySelectorAll('[data-action="upload-photo"]').forEach((button) => button.addEventListener('click', () => openUploadRecognition('photo')));
  document.querySelectorAll('[data-action="manual-add"]').forEach((button) => button.addEventListener('click', openManualAdd));
  document.querySelectorAll('[data-action="toggle-manage"]').forEach((button) => button.addEventListener('click', () => store.set({ inventoryManageMode: !store.get().inventoryManageMode })));
  bindInventoryRowEvents();
  document.querySelectorAll('[data-action="show-reminder"]').forEach((button) => button.addEventListener('click', openNotificationCenter));
  document.querySelectorAll('[data-action="open-diy"]').forEach((button) => button.addEventListener('click', () => navigateView({ activeTab: 'recipe', recipeMode: 'diy', selectedRecipeId: null })));
  document.querySelectorAll('[data-action="open-favorites"]').forEach((button) => button.addEventListener('click', () => navigateView({ activeTab: 'recipe', recipeMode: 'favorites', selectedRecipeId: null })));
  document.querySelectorAll('[data-action="back-to-feed"]').forEach((button) => button.addEventListener('click', () => returnWithinApp({ activeTab: 'recipe', recipeMode: 'feed', selectedRecipeId: null })));
  document.querySelectorAll('[data-action="back-to-options"]').forEach((button) => button.addEventListener('click', () => returnWithinApp({ activeTab: 'recipe', recipeMode: 'options', selectedRecipeId: null })));
  document.querySelectorAll('[data-action="refresh-feed"]').forEach((button) => button.addEventListener('click', restartDailyRecommendations));
  document.querySelectorAll('[data-action="cancel-generation"]').forEach((button) => button.addEventListener('click', () => {
    recipeGenerationRun += 1;
    cancelAllAiRequests();
    store.set({ isGenerating: false, dailyRecommendationError: '本次生成已取消。你可以点击“重新连接并生成”再试一次。' });
  }));
  document.querySelectorAll('[data-action="favorite-recipe"]').forEach((button) => button.addEventListener('click', () => toggleFavorite(button.dataset.id, button)));
  document.querySelectorAll('[data-action="view-recipe"]').forEach((button) => button.addEventListener('click', () => openRecipeDetail(button.dataset.id)));
  document.querySelectorAll('[data-action="want-recipe"]').forEach((button) => button.addEventListener('click', () => chooseRecipe(button.dataset.id)));
  document.querySelector('[data-form="planner"]')?.addEventListener('submit', handleGenerate);
  document.querySelector('[data-form="follow-up"]')?.addEventListener('submit', handleFollowUp);
  document.querySelectorAll('[data-shopping-name]').forEach((input) => input.addEventListener('change', () => completeShoppingItem(input.dataset.shoppingName, input)));
  document.querySelector('[data-form="shopping-add"]')?.addEventListener('submit', addShoppingItem);
  document.querySelectorAll('[data-action="remove-essential"]').forEach((button) => button.addEventListener('click', () => removeEssential(button.dataset.name)));
  document.querySelector('[data-form="essential-add"]')?.addEventListener('submit', addEssential);
  document.querySelectorAll('[data-essential-threshold]').forEach((input) => input.addEventListener('change', updateEssentialThreshold));
  document.querySelector('[data-form="constraint-add"]')?.addEventListener('submit', addConstraint);
  document.querySelectorAll('[data-action="remove-constraint"]').forEach((button) => button.addEventListener('click', () => removeConstraint(button.dataset.kind, button.dataset.name)));
  document.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('change', updateNotificationSetting));
  document.querySelectorAll('[data-profile-tag]').forEach((input) => input.addEventListener('change', updateProfileTags));
  document.querySelectorAll('[data-profile-text]').forEach((input) => input.addEventListener('change', updateProfileText));
  document.querySelectorAll('[data-profile-temp]').forEach((input) => input.addEventListener('change', updateProfileTemperature));
  document.querySelector('[data-profile="mealsPerDay"]')?.addEventListener('change', updateMealsPerDay);
  document.querySelectorAll('[data-meal-time]').forEach((input) => input.addEventListener('change', updateMealTime));
  document.querySelectorAll('[data-action="enable-notifications"]').forEach((button) => button.addEventListener('click', requestNotificationPermission));
  document.querySelectorAll('[data-action="reset-demo"]').forEach((button) => button.addEventListener('click', () => { store.reset(); refreshDailyRecommendations(); notify('演示数据已恢复'); }));
  document.querySelectorAll('[data-action="review-pending"]').forEach((button) => button.addEventListener('click', () => { const pending = store.get().pendingMealReviews[0]; if (pending) openConsumptionReview(pending.recipe, null, pending.id); }));
  document.querySelectorAll('[data-action="check-plan-now"]').forEach((button) => button.addEventListener('click', () => {
    const plan = store.get().plannedMeals.find((item) => ['planned', 'awaiting_review'].includes(item.status));
    if (plan?.status === 'awaiting_review') openConsumptionReview(plan.recipe, plan.id); else openPlannedMealCheck(plan);
  }));
}

function updateInventorySearch(event) {
  store.set({ inventoryQuery: event.currentTarget.value }, { silent: true });
  const state = store.get();
  const filtered = getFilteredInventory(state);
  const results = document.querySelector('[data-inventory-results]');
  const count = document.querySelector('[data-inventory-count]');
  if (!results || !count) return;
  count.textContent = `${filtered.length} 项`;
  results.innerHTML = filtered.map((item) => renderFoodRow(item, state.inventoryManageMode)).join('') || '<div class="empty-list">没有符合条件的食材</div>';
  bindInventoryRowEvents(results);
}

function bindInventoryRowEvents(root = document) {
  root.querySelectorAll('[data-action="delete-item"]').forEach((button) => button.addEventListener('click', () => deleteInventoryItem(button.dataset.id)));
  root.querySelectorAll('[data-action="edit-item"]').forEach((button) => button.addEventListener('click', () => openItemDetail(button.dataset.id)));
}

async function refreshDailyRecommendations() {
  if (store.get().isGenerating) return;
  const runId = ++recipeGenerationRun;
  store.set({ isGenerating: true, dailyRecommendationError: null });
  try {
    const state = store.get();
    const rotations = ['清爽但有味道，做法不要重复上一组', '有一点新加坡家常灵感，同时照顾现有口味画像', '适合今天节奏的全新组合', '换一种烹饪技法和地区风味', '优先组合本轮抽取的部分库存'];
    const refreshIndex = state.feedRefreshCount || 0;
    const pool = sortInventoryByExpiry(recipeSelectableInventory(state.inventory));
    const rotated = pool.length ? [...pool.slice(refreshIndex % pool.length), ...pool.slice(0, refreshIndex % pool.length)] : [];
    const selectedIngredientIds = rotated.filter((_, index) => index % 2 === 0).slice(0, 4).map((item) => item.id);
    const prompt = rotations[refreshIndex % rotations.length];
    const input = { ...state.planningInput, prompt, selectedIngredientIds, generationNonce: `${localDateKey()}-${refreshIndex}-${Date.now()}` };
    const history = [...state.dailyRecommendations, ...state.recipes].slice(-8);
    const recipes = await generateRecipes({ input, inventory: state.inventory, profile: state.profile, count: 4, history });
    if (runId !== recipeGenerationRun) return;
    store.update((next) => { next.dailyRecommendations = recipes; next.dailyRecommendationError = null; next.feedRefreshCount = (next.feedRefreshCount || 0) + 1; next.isGenerating = false; next.recipeMode = 'feed'; });
    hydrateRecipeImages(recipes, 'daily');
    notify('今日推荐已经换了一组');
  } catch (error) {
    if (runId !== recipeGenerationRun) return;
    store.set({ isGenerating: false, dailyRecommendationError: error.message || '生成失败，请重试' });
    notify('没有生成假菜谱：AI 服务连接失败');
  }
}

function restartDailyRecommendations() {
  if (store.get().isGenerating) {
    recipeGenerationRun += 1;
    cancelAllAiRequests();
    store.set({ isGenerating: false, dailyRecommendationError: null });
  }
  window.setTimeout(refreshDailyRecommendations, 0);
}

async function hydrateRecipeImages(recipes, target) {
  const enriched = await enrichRecipeImages(recipes);
  const byId = new Map(enriched.map((recipe) => [recipe.id, recipe]));
  store.update((next) => {
    if (target === 'daily') next.dailyRecommendations = next.dailyRecommendations.map((recipe) => byId.get(recipe.id) || recipe);
    else next.recipes = next.recipes.map((recipe) => byId.get(recipe.id) || recipe);
  });
}

async function handleGenerate(event, followUp = '') {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = { prompt: form.get('prompt'), servings: Number(form.get('servings')), prepTime: Number(form.get('prepTime')), carbId: form.get('carbId'), selectedIngredientIds: form.getAll('priority'), followUp };
  store.set({ isGenerating: true, planningInput: input, notice: null, dailyRecommendationError: null });
  try {
    const state = store.get();
    const recipes = await generateRecipes({ input, inventory: state.inventory, profile: state.profile, count: 4, history: state.recipes.slice(-5) });
    const unsafe = recipes.flatMap((recipe) => validateRecipe(recipe, state.inventory, state.profile).filter((error) => error.includes('过敏') || error.includes('不喜欢')));
    if (unsafe.length) throw new Error(unsafe.join('；'));
    store.update((next) => { next.recipes.push(...recipes); next.isGenerating = false; });
    navigateView({ activeTab: 'recipe', recipeMode: 'options', selectedRecipeId: null });
    hydrateRecipeImages(recipes, 'custom');
    notify(`已生成 ${recipes.length} 道可选菜谱`);
  } catch (error) { store.set({ isGenerating: false }); notify(error.message || '生成失败，请重试'); }
}

async function handleFollowUp(event) {
  event.preventDefault();
  const followUp = new FormData(event.currentTarget).get('followUp').trim();
  const input = { ...store.get().planningInput, prompt: `${store.get().planningInput.prompt}；补充：${followUp}`, followUp };
  store.set({ planningInput: input, recipeMode: 'diy' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const form = document.querySelector('[data-form="planner"]');
  if (form) form.requestSubmit();
}

function toggleFavorite(id, button) {
  const isSaved = store.get().favorites.includes(id);
  if (!isSaved) button?.classList.add('star-burst');
  window.setTimeout(() => store.update((next) => { next.favorites = isSaved ? next.favorites.filter((entry) => entry !== id) : [...next.favorites, id]; }), isSaved ? 0 : 280);
  notify(isSaved ? '已取消收藏' : '已加入收藏 ✨');
}

function openRecipeDetail(id) {
  const currentMode = store.get().recipeMode;
  store.update((next) => {
    for (const collection of [next.dailyRecommendations, next.recipes]) {
      const recipe = collection.find((item) => String(item.id) === String(id));
      if (!recipe) continue;
      recipe.prep = recipeStepList(recipe.prep, ['洗净食材并擦干；肉类按菜谱份量切配，生熟砧板分开。', '提前量好全部调味料，放在灶台旁备用。']);
      recipe.steps = recipeStepList(recipe.steps, ['中火预热锅具约 1 分钟，再按菜谱建议加入食用油。', '先下较难熟的食材，保持合适火力并按时间翻动。', '加入容易熟的食材和调味料，尝味后只做小幅调整。', '确认肉类熟透、蔬菜达到目标口感后立即关火装盘。']);
      recipe.tips = recipeStepList(recipe.tips);
      if (!Array.isArray(recipe.ingredients)) recipe.ingredients = [];
    }
  });
  navigateView({ activeTab: 'recipe', selectedRecipeId: String(id), recipeReturnMode: currentMode === 'options' ? 'options' : 'feed', recipeMode: 'detail' });
}

function mergeShoppingItems(existing, incoming, recipeId) {
  const map = new Map(existing.map((item) => [item.name, item]));
  incoming.forEach((item) => {
    const previous = map.get(item.name);
    const sourceRecipeIds = [...new Set([...(previous?.sourceRecipeIds || []), String(recipeId)])];
    map.set(item.name, {
      ...previous,
      ...item,
      source: previous?.source || 'recipe',
      sourceRecipeIds,
      status: 'to_buy'
    });
  });
  return [...map.values()];
}

function removeRecipeShoppingSources(items, recipeId) {
  const target = String(recipeId);
  return items.flatMap((item) => {
    if (!(item.sourceRecipeIds || []).map(String).includes(target)) return [item];
    const sourceRecipeIds = item.sourceRecipeIds.filter((id) => String(id) !== target);
    if (!sourceRecipeIds.length && item.source === 'recipe') return [];
    return [{ ...item, sourceRecipeIds }];
  });
}

function chooseRecipe(id) {
  const state = store.get();
  const recipe = findRecipe(state, id);
  if (!recipe) return;
  const existingPlan = state.plannedMeals.find((item) => String(item.recipeId) === String(id) && ['planned', 'awaiting_review'].includes(item.status));
  if (existingPlan?.status === 'awaiting_review') { notify('这道菜已经确认做过，请先完成实际用量核对'); return; }
  if (existingPlan?.status === 'planned') {
    let cancelledPlan = null;
    store.update((next) => {
      const current = next.plannedMeals.find((item) => item.id === existingPlan.id);
      if (current) {
        current.status = 'cancelled';
        current.cancelledAt = new Date().toISOString();
        cancelledPlan = current;
      }
      next.shoppingItems = removeRecipeShoppingSources(next.shoppingItems, id);
    });
    const current = store.get();
    if (cancelledPlan) savePlannedMeal(current.auth.session, cancelledPlan, current.profile, current.notificationSettings).catch(() => {});
    notify('已取消今日计划；只由这道菜产生的采购项也已移除');
    return;
  }
  const shoppingItems = buildShoppingList(recipe, state.inventory);
  let createdPlan = null;
  store.update((next) => {
    next.selectedRecipeId = id;
    next.recipes = next.recipes.some((item) => String(item.id) === String(id)) ? next.recipes : [...next.recipes, recipe];
    next.shoppingItems = mergeShoppingItems(next.shoppingItems, shoppingItems, id);
    next.shoppingDismissed = next.shoppingDismissed.filter((name) => !shoppingItems.some((item) => item.name === name));
    const now = new Date();
    const plannedFor = localDateKey(now);
    const confirmationTime = next.notificationSettings.planConfirmationTime || '21:30';
    createdPlan = { id: `plan-${Date.now()}`, recipeId: id, recipe, status: 'planned', plannedFor, confirmationTime, reviewAt: buildPlanReviewAt(plannedFor, confirmationTime, now), createdAt: now.toISOString(), inventoryCommitted: false };
    next.plannedMeals.push(createdPlan);
  });
  const current = store.get(); savePlannedMeal(current.auth.session, createdPlan, current.profile, current.notificationSettings).catch(() => {});
  notify(shoppingItems.length ? `已加入今日计划；${shoppingItems.length} 项缺口进入采购，库存暂不扣减` : `已加入今日计划；到时间确认实际用量后才更新库存`);
}

function openPlannedMealCheck(plan) {
  if (!plan || document.querySelector('.modal-backdrop')) return;
  const modal = createModal(`<div class="planned-meal-check"><span class="food-symbol large">${plan.recipe.emoji || '🍽️'}</span><div class="modal-heading"><p class="eyebrow">TODAY'S PLAN</p><h2>今天的「${escapeHtml(plan.recipe.recipeName)}」做了吗？</h2><p>现在只确认实际情况；只有选择“做了”后，才会继续核对食材消耗。</p></div><div class="modal-actions stacked-mobile"><button class="secondary-button" data-plan-later>改到明天</button><button class="secondary-button" data-plan-skip>今天没做</button><button class="primary-button" data-plan-made>做了，核对用量</button></div></div>`);
  modal.querySelector('[data-plan-skip]').addEventListener('click', () => { store.update((next) => { const current = next.plannedMeals.find((item) => item.id === plan.id); if (current) current.status = 'skipped'; }); modal.remove(); notify('已记录今天没有做，不会扣减库存'); });
  modal.querySelector('[data-plan-later]').addEventListener('click', () => { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); store.update((next) => { const current = next.plannedMeals.find((item) => item.id === plan.id); if (current) { current.plannedFor = localDateKey(tomorrow); current.reviewAt = buildPlanReviewAt(current.plannedFor, current.confirmationTime, new Date(0)); current.reviewSnoozedUntil = null; current.reminderSentAt = null; } }); modal.remove(); notify('已把这道菜移到明天，不会扣减库存'); });
  modal.querySelector('[data-plan-made]').addEventListener('click', () => {
    const noTracking = store.get().notificationSettings.mealReviewMode === 'none';
    store.update((next) => { const current = next.plannedMeals.find((item) => item.id === plan.id); if (current) { current.status = noTracking ? 'reviewed_without_tracking' : 'awaiting_review'; current.madeConfirmedAt = new Date().toISOString(); current.reviewSnoozedUntil = null; } });
    modal.remove();
    if (noTracking) notify('已记录做过这道菜；按你的设置不追踪用量，库存未自动扣减'); else openConsumptionReview(plan.recipe, plan.id);
  });
}

function openConsumptionReview(recipe, planId = null, pendingId = null) {
  if (!recipe || document.querySelector('.modal-backdrop')) return;
  const seen = new Set();
  const reviewable = recipe.ingredients.flatMap((ingredient) => {
    const current = findInventoryItem(store.get().inventory, ingredient.canonicalName);
    if (!current || seen.has(current.id)) return [];
    seen.add(current.id);
    return [{ ingredient, current }];
  });
  const rows = reviewable.map(({ ingredient, current }) => {
    if (current.managementMode === 'tracked_quantity') {
      const sameUnit = !ingredient.unit || ingredient.unit === current.unit;
      const suggested = sameUnit ? ingredient.requiredAmount : Math.min(1, Number(current.quantity || 0));
      return `<label class="consumption-review-row" data-review-item data-id="${current.id}" data-mode="tracked_quantity"><span class="food-symbol">${ingredientIcon(ingredient.name)}</span><span><strong>${escapeHtml(ingredient.name)}</strong><small>${sameUnit ? `菜谱建议 ${ingredient.requiredAmount} ${escapeHtml(ingredient.unit)}` : `菜谱按 ${escapeHtml(ingredient.unit)}、库存按 ${escapeHtml(current.unit)}记录，请填写实际库存单位`}</small></span><input type="number" min="0" max="${Number(current.quantity || 0)}" step="0.25" value="${suggested}"><em>${escapeHtml(current.unit)}</em></label>`;
    }
    if (current.managementMode === 'approximate_stock') {
      return `<label class="consumption-review-row" data-review-item data-id="${current.id}" data-mode="approximate_stock"><span class="food-symbol">${ingredientIcon(ingredient.name)}</span><span><strong>${escapeHtml(ingredient.name)}</strong><small>使用前约 ${current.stockPercentage}%；请填写用后剩余</small></span><input type="number" min="0" max="100" step="1" value="${current.stockPercentage}"><em>%</em></label>`;
    }
    return `<label class="consumption-review-row" data-review-item data-id="${current.id}" data-mode="freshness_only"><span class="food-symbol">${ingredientIcon(ingredient.name)}</span><span><strong>${escapeHtml(ingredient.name)}</strong><small>这类食材不精确追踪数量</small></span><select><option value="keep">还有剩余，继续保留</option><option value="used_up">已经用完，从食材库删除</option></select></label>`;
  }).join('');
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">CONSUMPTION REVIEW</p><h2>实际用量和菜谱一样吗？</h2><p>请按这顿饭真实使用情况修改。提交前不会扣减任何库存；提交后会计算并显示剩余量。</p></div><form data-consumption-form><div class="consumption-list">${rows || '<div class="empty-list">这道菜没有可与当前库存对应的食材；确认后只记录用餐，不扣库存。</div>'}</div><div class="modal-actions"><button type="button" class="secondary-button" data-consumption-later>1 小时后再提醒</button><button class="primary-button" type="submit">审核完成，更新库存</button></div></form>`);
  modal.querySelector('[data-consumption-later]').addEventListener('click', () => {
    if (planId) store.update((next) => { const plan = next.plannedMeals.find((item) => item.id === planId); if (plan) { plan.status = 'awaiting_review'; snoozePlanReview(plan); } });
    modal.remove();
    notify('已延后 1 小时；期间库存不会改变');
  });
  modal.querySelector('[data-consumption-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    event.currentTarget.querySelectorAll('[data-review-item]').forEach((row) => {
      if (row.dataset.mode === 'tracked_quantity') values[row.dataset.id] = { amount: Number(row.querySelector('input').value) };
      if (row.dataset.mode === 'approximate_stock') values[row.dataset.id] = { remainingPercentage: Number(row.querySelector('input').value) };
      if (row.dataset.mode === 'freshness_only') values[row.dataset.id] = { usedUp: row.querySelector('select').value === 'used_up' };
    });
    store.update((next) => {
      const events = applyMealConsumption(next, recipe, values);
      next.mealLogs.push({ id: `meal-${Date.now()}`, planId, recipeName: recipe.recipeName, madeAt: new Date().toISOString(), servings: recipe.servings, events });
      const plan = next.plannedMeals.find((item) => item.id === planId);
      if (plan) { plan.status = 'reviewed'; plan.reviewedAt = new Date().toISOString(); plan.inventoryCommitted = true; plan.consumptionEvents = events; }
      if (pendingId) next.pendingMealReviews = next.pendingMealReviews.filter((item) => item.id !== pendingId);
    });
    modal.remove();
    notify('审核完成：已按实际用量计算并更新食材库');
  });
}

function completeShoppingItem(name, input) {
  const row = input.closest('[data-shopping-row]');
  row?.classList.add('removing');
  window.setTimeout(() => {
    store.update((next) => { next.shoppingItems = next.shoppingItems.filter((item) => item.name !== name); if (!next.shoppingDismissed.includes(name)) next.shoppingDismissed.push(name); });
  }, 520);
}

function addShoppingItem(event) {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get('name').trim();
  if (!name) return;
  store.update((next) => { next.shoppingDismissed = next.shoppingDismissed.filter((item) => item !== name); if (!next.shoppingItems.some((item) => item.name === name)) next.shoppingItems.push({ name, requiredAmount: 1, unit: '份', reason: '手动添加', status: 'to_buy', source: 'manual' }); });
  notify(`${name} 已加入采购清单`);
}

function addConstraint(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget); const kind = form.get('kind'); const name = form.get('name').trim(); if (!name) return;
  store.update((next) => { if (!next.profile[kind].includes(name)) next.profile[kind].push(name); });
}

function removeConstraint(kind, name) { store.update((next) => { next.profile[kind] = next.profile[kind].filter((item) => item !== name); }); }

function scheduleProfileSync() {
  window.clearTimeout(profileSyncTimer);
  profileSyncTimer = window.setTimeout(() => { const state = store.get(); saveRemoteProfile(state.auth.session, state.profile, state.notificationSettings).catch(() => {}); }, 600);
}

function updateProfileTags(event) {
  const key = event.target.dataset.profileTag;
  store.update((next) => { const selected = new Set(next.profile[key] || []); if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value); next.profile[key] = [...selected]; next.profile.tasteProfileSummary = buildTasteProfile(next.profile); });
  scheduleProfileSync();
}

function updateProfileText(event) {
  const key = event.target.dataset.profileText;
  store.update((next) => { next.profile[key] = event.target.value.trim(); next.profile.tasteProfileSummary = buildTasteProfile(next.profile); });
  scheduleProfileSync();
}

function updateProfileTemperature(event) {
  const key = event.target.dataset.profileTemp; const value = Number(event.target.value);
  store.update((next) => { next.profile[key] = value; });
  scheduleProfileSync();
  notify('温度已更新，下一次储存检索会使用新条件');
}

function addEssential(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget); const name = form.get('name').trim(); const threshold = Number(form.get('threshold')) || 20; if (!name) return;
  store.update((next) => { const items = normalizeEssentialItems(next.profile); if (!items.some((item) => item.name === name)) items.push({ name, threshold }); next.profile.essentialItems = items; next.shoppingDismissed = next.shoppingDismissed.filter((item) => item !== name); });
}

function removeEssential(name) { store.update((next) => { next.profile.essentialItems = normalizeEssentialItems(next.profile).filter((item) => item.name !== name); }); }
function updateEssentialThreshold(event) { const name = event.target.dataset.essentialThreshold; const value = Number(event.target.value) || 20; store.update((next) => { next.profile.essentialItems = normalizeEssentialItems(next.profile).map((item) => item.name === name ? { ...item, threshold: value } : item); }); }
function updateMealsPerDay(event) { const count = Number(event.target.value); store.update((next) => { next.profile.mealsPerDay = count; while (next.profile.mealTimes.length < count) next.profile.mealTimes.push('12:00'); }); }
function updateMealTime(event) { const index = Number(event.target.dataset.mealTime); store.update((next) => { next.profile.mealTimes[index] = event.target.value; }); }

function updateNotificationSetting(event) {
  const key = event.target.dataset.setting;
  const value = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'number' ? Number(event.target.value) : event.target.value;
  store.update((next) => { next.notificationSettings[key] = value; if (key === 'planningTime') next.profile.planningTime = value; if (key === 'mealReviewMode') next.profile.mealReviewMode = value; if (key === 'afterMealHours') next.profile.afterMealHours = value; if (key === 'fixedReviewTime') next.profile.fixedReviewTime = value; });
  scheduleProfileSync();
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) { notify('当前浏览器不支持系统通知'); return; }
  const permission = await Notification.requestPermission();
  store.update((next) => { next.notificationSettings.enabled = permission === 'granted'; });
  notify(permission === 'granted' ? '电脑通知已开启' : '通知未授权，可继续使用应用内提醒');
}

function openCaptureHub() {
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">ADD INGREDIENTS</p><h2>选择添加方式</h2><p>手动添加会先检索储存建议；图片识别会先生成可核对的清单，两条流程彼此独立。</p></div><div class="capture-menu"><button data-source="receipt">${icon('receipt')}<span><strong>上传购物小票</strong><small>识别商品名与包装数量，再逐项确认</small></span></button><button data-source="photo">${icon('upload')}<span><strong>上传食材合照</strong><small>网页版选择图片，视觉模型识别后生成表格</small></span></button><button data-source="manual">${icon('plus')}<span><strong>手动添加</strong><small>输入食材名后生成分类、储存方式与日期</small></span></button></div>`);
  modal.querySelector('[data-source="receipt"]').addEventListener('click', () => { modal.remove(); openUploadRecognition('receipt'); });
  modal.querySelector('[data-source="photo"]').addEventListener('click', () => { modal.remove(); openUploadRecognition('photo'); });
  modal.querySelector('[data-source="manual"]').addEventListener('click', () => { modal.remove(); openManualAdd(); });
}

function openManualAdd() {
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">MANUAL ADD</p><h2>手动添加食材</h2><p>先输入食材名称，再生成适用于新加坡日常储存环境的分类、储存方式和参考日期。</p></div><form data-manual-search class="manual-search"><label>食材名称<input name="name" placeholder="请输入食材名称" autocomplete="off" required></label><button class="primary-button" type="submit">${icon('spark')} 生成储存建议</button></form><div data-manual-result class="manual-result-empty">这里不会提前猜“新食材”，也不会在确认前显示图标。</div>`);
  modal.querySelector('[data-manual-search]').addEventListener('submit', async (event) => {
    event.preventDefault(); const name = new FormData(event.currentTarget).get('name').trim(); if (!name) return;
    const result = modal.querySelector('[data-manual-result]'); result.innerHTML = '<div class="capture-loading"><span class="spinner"></span> 正在检索分类与储存建议</div>';
    try { const profile = store.get().profile; const guidance = await getStorageGuidance(name, { fridgeC: profile.fridgeTemperatureC, freezerC: profile.freezerTemperatureC }); renderManualGuidance(modal, guidance); } catch (error) { result.innerHTML = `<div class="alert danger-alert">${escapeHtml(error.message)}</div>`; }
  });
}

function storageDate(option) {
  if (!option?.available || !option.days) return '';
  const date = new Date();
  date.setDate(date.getDate() + Number(option.days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderManualGuidance(modal, guidance) {
  const result = modal.querySelector('[data-manual-result]');
  const available = guidance.storageOptions.filter((option) => option.available);
  const first = available[0] || null;
  const temperatures = guidance.applianceTemperatures || { fridgeC: store.get().profile.fridgeTemperatureC, freezerC: store.get().profile.freezerTemperatureC };
  const sourceRows = [...new Map(guidance.storageOptions.map((option) => [option.source?.url || guidance.source?.url, option.source || guidance.source]).filter(([url]) => url)).values()];
  const packageStateField = guidance.packageStateRelevant ? `<label class="package-state-field">包装状态<select data-package-state><option value="opened" ${guidance.packageState !== 'sealed' ? 'selected' : ''}>已开封（正在使用）</option><option value="sealed" ${guidance.packageState === 'sealed' ? 'selected' : ''}>未开封</option></select><small>开封状态会改变适用储存方式和提醒日期</small></label>` : '';
  result.innerHTML = `<form data-manual-confirm class="manual-confirm"><div class="guidance-summary"><div><span class="eyebrow">已生成 · 分类与资料检索</span><h3>${escapeHtml(guidance.name)}</h3><p>自动归入「${escapeHtml(CATEGORY_LABELS[guidance.uiCategory])}」；加入列表时才匹配食材图标。</p></div><span class="source-chip">逐食材匹配</span></div><div class="temperature-basis">按你的设备设置计算：冷藏 <strong>${temperatures.fridgeC ?? 4}°C</strong> · 冷冻 <strong>${temperatures.freezerC ?? -18}°C</strong><button type="button" data-open-profile>修改</button></div><div class="manual-fields">${packageStateField}<label>数量<input data-quantity type="number" min="${COUNT_UNITS.includes(guidance.unit) ? 1 : 0}" step="${COUNT_UNITS.includes(guidance.unit) ? 1 : 25}" value="${guidance.quantity}"></label><label>单位<select data-unit>${[guidance.unit, '克', '个', '瓶', '袋', '盒', '包'].filter((value, index, array) => array.indexOf(value) === index).map((unit) => `<option>${unit}</option>`).join('')}</select></label></div><div class="field-label">可以怎样储存？<span>先看适用条件，再按你的使用打算选择。日期是最佳品质提醒，不是安全保证。</span></div><div class="manual-storage-grid">${guidance.storageOptions.map((option) => `<label class="manual-storage-option ${option.available ? '' : 'disabled'}"><input type="radio" name="storage" value="${option.location}" data-days="${option.days || ''}" ${first && option.location === first.location ? 'checked' : ''} ${option.available ? '' : 'disabled'}><span><strong>${option.location}</strong><em>${option.available ? (option.days ? `建议 ${option.days} 天内 · 至 ${storageDate(option)}` : '按包装说明') : '暂不适用'}</em>${option.sourceRange ? `<b>${escapeHtml(option.sourceRange)}</b>` : ''}${option.preparation ? `<small>前提：${escapeHtml(option.preparation)}</small>` : ''}<small>${escapeHtml(option.note || '')}</small>${option.temperatureBasis ? `<small>${escapeHtml(option.temperatureBasis)}</small>` : ''}</span></label>`).join('')}</div>${!first ? '<div class="alert danger-alert">当前名称或温度条件不足以给出可靠方式。请返回补充具体品种、部位或包装状态，系统不会套用统一天数。</div>' : ''}${guidance.expiryRequired ? `<div class="package-confirm"><strong>请优先确认包装日期</strong><p>调味品、主食和生鲜食品都会保留品质提醒；有包装标注时，它比通用参考期限更可靠。</p><label>包装标注到期日（推荐）<input type="date" data-package-date></label><button type="button" data-use-reference>暂按参考日期</button></div>` : ''}<label class="expiry-editor">预计最佳品质提醒日<input type="date" data-expiry value="${storageDate(first)}" ${first ? '' : 'disabled'}><small data-days-left>${formatDaysLeft(storageDate(first))}</small></label><div class="retrieval-note"><strong>资料来源</strong>${sourceRows.map((source) => { const url = safeSourceUrl(source?.url); return url ? `<a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>` : `<span>${escapeHtml(source?.title || '本地食材知识库')}</span>`; }).join('')}<span>包装说明、连续温控和实际状态优先。</span></div><div class="modal-actions"><button type="button" class="secondary-button" data-close>取消</button><button class="primary-button" type="submit" ${first ? '' : 'disabled'}>确认并加入食材库</button></div></form>`;
  const form = result.querySelector('[data-manual-confirm]');
  form.querySelector('[data-open-profile]')?.addEventListener('click', () => { modal.remove(); store.set({ activeTab: 'profile' }); });
  form.querySelector('[data-package-state]')?.addEventListener('change', (event) => {
    const packageState = event.target.value;
    const storageOptions = guidance.packageStateOptions?.[packageState];
    if (storageOptions) renderManualGuidance(modal, { ...guidance, packageState, storageOptions });
  });
  form.querySelectorAll('input[name="storage"]').forEach((radio) => radio.addEventListener('change', () => { const option = guidance.storageOptions.find((item) => item.location === radio.value); const date = storageDate(option); form.querySelector('[data-expiry]').value = date; form.querySelector('[data-days-left]').textContent = formatDaysLeft(date); }));
  form.querySelector('[data-unit]').addEventListener('change', (event) => syncQuantityForUnit(form.querySelector('[data-quantity]'), event.target.value));
  form.querySelector('[data-expiry]').addEventListener('change', (event) => { form.querySelector('[data-days-left]').textContent = formatDaysLeft(event.target.value); });
  form.querySelector('[data-package-date]')?.addEventListener('change', (event) => { if (event.target.value) { form.querySelector('[data-expiry]').value = event.target.value; form.querySelector('[data-days-left]').textContent = formatDaysLeft(event.target.value); } });
  form.querySelector('[data-use-reference]')?.addEventListener('click', () => notify('已暂用参考日期，入库后仍可在管理中修改'));
  form.addEventListener('submit', (event) => { event.preventDefault(); const selected = form.querySelector('input[name="storage"]:checked'); if (!selected) return; const storage = selected.value; const expiryDate = form.querySelector('[data-expiry]').value || null; const item = buildInventoryItem(guidance, { name: guidance.name, storage, expiryDate, quantity: Number(form.querySelector('[data-quantity]').value), unit: form.querySelector('[data-unit]').value, packageState: guidance.packageState || null }); store.update((next) => next.inventory.unshift(item)); modal.remove(); notify(`${guidance.name} 已按独立储存建议加入库存`); });
}

function syncQuantityForUnit(input, unit) {
  if (COUNT_UNITS.includes(unit)) { input.min = '1'; input.step = '1'; input.value = Math.max(1, Math.round(Number(input.value) || 1)); }
  else if (unit === '克') { input.min = '25'; input.step = '25'; input.value = '200'; }
  else { input.min = '1'; input.step = '1'; if (!Number(input.value)) input.value = '1'; }
}

function formatDaysLeft(date) {
  const days = daysUntil(date); if (days == null) return '请选择日期'; if (days < 0) return `已过期 ${Math.abs(days)} 天`; if (days === 0) return '今天到期'; return `还有 ${days} 天`;
}

function openUploadRecognition(source) {
  const label = source === 'receipt' ? '购物小票' : '食材合照';
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">IMAGE RECOGNITION</p><h2>上传${label}</h2><p>网页版从电脑或手机相册选择图片。图片会交给视觉模型识别；任何结果都要在下一步确认后才入库。</p></div><form data-upload-form class="upload-form"><label class="upload-drop">${icon('upload')}<strong>选择${label}图片</strong><span>支持 JPG、PNG、WEBP</span><input type="file" name="image" accept="image/jpeg,image/png,image/webp" required></label><img data-upload-preview alt="所选图片预览" hidden><button class="primary-button full-width" type="submit">开始识别并生成清单</button></form>`);
  const fileInput = modal.querySelector('input[type="file"]'); const preview = modal.querySelector('[data-upload-preview]');
  fileInput.addEventListener('change', () => { const file = fileInput.files[0]; if (!file) return; preview.src = URL.createObjectURL(file); preview.hidden = false; });
  modal.querySelector('[data-upload-form]').addEventListener('submit', async (event) => { event.preventDefault(); const file = fileInput.files[0]; if (!file) return; const image = await fileToDataUrl(file); modal.querySelector('.modal-body').innerHTML = '<div class="capture-loading"><span class="spinner"></span> 正在识别图片并整理清单</div>'; try { const profile = store.get().profile; const data = await analyzeInventory({ source, image, mimeType: file.type, fileName: file.name, temperatures: { fridgeC: profile.fridgeTemperatureC, freezerC: profile.freezerTemperatureC } }); renderBatchReview(modal, data.candidates, `${label}识别`); } catch (error) { modal.querySelector('.modal-body').innerHTML = `<div class="alert danger-alert">${escapeHtml(error.message)}</div>`; } });
}

function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }

function renderBatchReview(modal, candidates, label) {
  modal.querySelector('.modal').classList.add('wide');
  modal.querySelector('.modal-body').innerHTML = `<div class="modal-heading"><p class="eyebrow">${escapeHtml(label)}</p><h2>确认识别清单</h2><p>请核对名称、分类、数量、储存方式和日期；包装日期敏感的食材会单独标出。</p></div><div class="batch-note"><span>储存日期会跟随所选方式变化</span><button type="button" data-default-all>全部采用当前参考日期</button></div><form data-batch-form><div class="batch-table">${candidates.map(renderBatchRow).join('')}</div><div class="modal-actions"><button type="button" class="secondary-button" data-close>取消</button><button class="primary-button" type="submit">确认 ${candidates.length} 项并加入库存</button></div></form>`;
  const rows = [...modal.querySelectorAll('[data-batch-row]')];
  rows.forEach((row, index) => { row.querySelectorAll('input[type="radio"]').forEach((radio) => radio.addEventListener('change', () => { const option = candidates[index].storageOptions.find((item) => item.location === radio.value); row.querySelector('[data-expiry]').value = storageDate(option); })); row.querySelector('[data-unit]').addEventListener('change', (event) => syncQuantityForUnit(row.querySelector('[data-quantity]'), event.target.value)); });
  modal.querySelector('[data-default-all]').addEventListener('click', () => { rows.forEach((row, index) => { const selected = row.querySelector('input[type="radio"]:checked'); const option = candidates[index].storageOptions.find((item) => item.location === selected.value); row.querySelector('[data-expiry]').value = storageDate(option); }); notify('已按当前储存方式填写参考日期'); });
  modal.querySelector('[data-batch-form]').addEventListener('submit', (event) => { event.preventDefault(); const items = rows.map((row, index) => buildInventoryItem(candidates[index], { name: row.querySelector('[data-name]').value.trim(), storage: row.querySelector('input[type="radio"]:checked').value, quantity: Number(row.querySelector('[data-quantity]').value), unit: row.querySelector('[data-unit]').value, expiryDate: row.querySelector('[data-expiry]').value || null })); store.update((next) => next.inventory.unshift(...items)); modal.remove(); notify(`${items.length} 项食材已加入库存`); });
}

function renderBatchRow(candidate, index) {
  const first = candidate.storageOptions.find((item) => item.location === candidate.storageLocation && item.available) || candidate.storageOptions.find((item) => item.available);
  return `<div class="batch-row" data-batch-row><div class="batch-item-main"><div><input class="name-input" data-name value="${escapeHtml(candidate.name)}" aria-label="食材名称"><small>${escapeHtml(CATEGORY_LABELS[candidate.uiCategory])}${candidate.expiryRequired ? ' · 包装日期需确认' : ''}</small></div></div><div class="batch-quantity"><input type="number" min="${COUNT_UNITS.includes(candidate.unit) ? 1 : 0}" step="${COUNT_UNITS.includes(candidate.unit) ? 1 : 25}" data-quantity value="${candidate.quantity}"><select data-unit>${[candidate.unit, '克', '个', '瓶', '袋', '盒', '包'].filter((value, i, array) => array.indexOf(value) === i).map((unit) => `<option>${unit}</option>`).join('')}</select></div><div class="storage-options">${candidate.storageOptions.map((option) => `<label class="storage-radio ${option.available ? '' : 'disabled'}"><input type="radio" name="storage-${index}" value="${option.location}" ${option.location === first.location ? 'checked' : ''} ${option.available ? '' : 'disabled'}><span>${option.location}<small>${option.available ? (option.days ? `${option.days} 天` : '按包装') : '不可用'}</small></span></label>`).join('')}</div><div class="date-confirm"><label>预计到期${candidate.expiryRequired ? '<em>请核对包装</em>' : ''}<input type="date" data-expiry value="${storageDate(first)}"></label></div></div>`;
}

function buildInventoryItem(candidate, values) {
  const itemDays = values.expiryDate ? daysUntil(values.expiryDate) : null;
  return { id: `ing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: values.name, canonicalName: candidate.normalizedName || candidate.canonicalName, category: candidate.category, uiCategory: candidate.uiCategory, managementMode: candidate.suggestedManagementMode || candidate.mode, storageLocation: values.storage, packageState: values.packageState || candidate.packageState || null, quantity: (candidate.suggestedManagementMode || candidate.mode) === 'freshness_only' ? null : values.quantity, unit: values.unit, stockPercentage: (candidate.suggestedManagementMode || candidate.mode) === 'approximate_stock' ? 100 : null, expiryDate: values.expiryDate, freshnessScore: itemDays == null ? null : Math.max(0, Math.min(95, itemDays * 10)), freshnessStatus: itemDays != null && itemDays < 0 ? 'expired_or_past_recorded_date' : itemDays != null && itemDays <= 3 ? 'use_soon' : 'fresh', freshnessConfidence: candidate.expiryRequired ? 'medium' : 'high', freshnessSource: candidate.expiryRequired ? 'human_or_reference' : 'retrieval_reference', freezable: Boolean(candidate.storageOptions?.find((item) => item.location === '冷冻')?.available), refrigeratedDays: candidate.storageOptions?.find((item) => item.location === '冷藏')?.days || null, frozenDays: candidate.storageOptions?.find((item) => item.location === '冷冻')?.days || null, icon: candidate.icon || ingredientIcon(values.name), story: candidate.story || '', nature: candidate.nature || '', cooking: candidate.cooking || '', storageGuidance: candidate.storageOptions || [] };
}

function deleteInventoryItem(id) {
  const item = store.get().inventory.find((entry) => entry.id === id); if (!item) return;
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">REMOVE ITEM</p><h2>确认已经用完了吗？</h2><p>删除「${escapeHtml(item.name)}」后，它会从食材库中移除。</p></div><div class="modal-actions"><button class="secondary-button" data-close>先保留</button><button class="primary-button danger-button" data-confirm-delete>确认删除</button></div>`);
  modal.querySelector('[data-confirm-delete]').addEventListener('click', () => { store.update((next) => { next.inventory = next.inventory.filter((entry) => entry.id !== id); }); modal.remove(); notify(`${item.name} 已从食材库删除`); });
}

function openItemDetail(id) {
  const item = store.get().inventory.find((entry) => entry.id === id); if (!item) return;
  const packageStateRelevant = Boolean(getIngredientGuidance(item.name || item.canonicalName || '')?.packageStateRelevant || item.uiCategory === 'staple' || item.uiCategory === 'condiment');
  const packageStateField = packageStateRelevant ? `<label>包装状态<select name="packageState"><option value="opened" ${item.packageState !== 'sealed' ? 'selected' : ''}>已开封</option><option value="sealed" ${item.packageState === 'sealed' ? 'selected' : ''}>未开封</option></select></label>` : '';
  const amountField = item.managementMode === 'tracked_quantity'
    ? `<label>当前剩余量<div class="edit-amount"><input name="quantity" type="number" min="0" step="0.25" value="${Number(item.quantity || 0)}"><span>${escapeHtml(item.unit)}</span></div></label>`
    : item.managementMode === 'approximate_stock'
      ? `<label>大约剩余百分比<div class="edit-amount"><input name="stockPercentage" type="number" min="0" max="100" step="1" value="${Number(item.stockPercentage || 0)}"><span>%</span></div></label>`
      : '<div class="freshness-edit-note">这类食材不记录精确数量；用完后可在管理模式中删除。</div>';
  const modal = createModal(`<form class="item-edit-form" data-item-edit><div class="item-detail"><span class="food-symbol large">${ingredientIcon(item.name)}</span><div class="modal-heading"><p class="eyebrow">INGREDIENT DETAILS</p><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.story || '')}</p></div></div><div class="item-detail-note"><strong>${escapeHtml(item.nature || '')}</strong><p>${escapeHtml(item.cooking || '')}</p></div><div class="item-edit-grid">${amountField}${packageStateField}<label>储存方式<select name="storageLocation">${STORAGE_VALUES.map((value) => `<option value="${value}" ${item.storageLocation === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>预计品质提醒日<input name="expiryDate" type="date" value="${escapeHtml(item.expiryDate || '')}"></label></div><div class="modal-actions"><button type="button" class="secondary-button" data-close>取消</button><button type="submit" class="primary-button">保存修改</button></div></form>`);
  const editForm = modal.querySelector('[data-item-edit]');
  const syncPackageReminder = () => {
    if (!packageStateRelevant) return;
    const packageState = editForm.elements.packageState?.value || 'opened';
    const location = editForm.elements.storageLocation.value;
    const option = getIngredientGuidance(item.name || item.canonicalName || '', packageState)?.storage?.find((entry) => entry.location === location && entry.available);
    if (option?.days) editForm.elements.expiryDate.value = storageDate(option);
  };
  editForm.elements.packageState?.addEventListener('change', syncPackageReminder);
  editForm.elements.storageLocation.addEventListener('change', syncPackageReminder);
  editForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    store.update((next) => {
      const current = next.inventory.find((entry) => entry.id === id);
      if (!current) return;
      if (packageStateRelevant) current.packageState = form.get('packageState') || 'opened';
      current.storageLocation = form.get('storageLocation');
      current.expiryDate = form.get('expiryDate') || null;
      if (current.managementMode === 'tracked_quantity') current.quantity = Math.max(0, Number(form.get('quantity') || 0));
      if (current.managementMode === 'approximate_stock') current.stockPercentage = Math.max(0, Math.min(100, Number(form.get('stockPercentage') || 0)));
    });
    modal.remove();
    notify(`${item.name}的剩余信息已更新`);
  });
}

function queueExpiredPrompt() {
  if (expiredPromptQueued || store.get().activeTab !== 'inventory') return;
  const item = store.get().inventory.find((entry) => (daysUntil(entry.expiryDate) ?? 0) < 0 && !store.get().expiredPromptHandled.includes(entry.id));
  if (!item) return;
  expiredPromptQueued = true;
  window.setTimeout(() => { expiredPromptQueued = false; if (store.get().activeTab !== 'inventory' || document.querySelector('.modal-backdrop')) return; openExpiredPrompt(item); }, 450);
}

function queueDuePlanReview() {
  const state = store.get();
  if (planPromptQueued || state.activeTab !== 'inventory' || !state.auth?.authenticated || !state.auth?.onboardingComplete) return;
  const plan = nextPlanForReview(state.plannedMeals, new Date());
  if (!plan || planPromptShown.has(plan.id)) return;
  planPromptQueued = true;
  window.setTimeout(() => {
    planPromptQueued = false;
    if (store.get().activeTab !== 'inventory') return;
    if (document.querySelector('.modal-backdrop')) {
      window.setTimeout(queueDuePlanReview, 1000);
      return;
    }
    planPromptShown.add(plan.id);
    if (plan.status === 'awaiting_review') openConsumptionReview(plan.recipe, plan.id);
    else openPlannedMealCheck(plan);
  }, 500);
}

function openExpiredPrompt(item) {
  const modal = createModal(`<div class="expired-dialog"><span>🫧</span><div class="modal-heading"><p class="eyebrow">A GENTLE CHECK-IN</p><h2>「${escapeHtml(item.name)}」已经到期了</h2><p>它可能已经完成了在冰箱里的使命。要现在把它从食材库删除吗？如果你还想亲自确认，也可以先保留，它会继续以紫色显示。</p></div><div class="modal-actions"><button class="secondary-button" data-keep-expired>先保留，我再看看</button><button class="primary-button danger-button" data-delete-expired>删除</button></div></div>`);
  const mark = () => store.update((next) => { if (!next.expiredPromptHandled.includes(item.id)) next.expiredPromptHandled.push(item.id); });
  modal.querySelector('[data-keep-expired]').addEventListener('click', () => { mark(); modal.remove(); notify(`${item.name} 已保留，并用紫色标记`); });
  modal.querySelector('[data-delete-expired]').addEventListener('click', () => { store.update((next) => { next.inventory = next.inventory.filter((entry) => entry.id !== item.id); next.expiredPromptHandled.push(item.id); }); modal.remove(); notify(`${item.name} 已删除，记得检查并妥善处理实物`); });
}

function openNotificationCenter() {
  const state = store.get();
  const urgent = sortInventoryByExpiry(state.inventory).filter((item) => { const value = daysUntil(item.expiryDate); return value != null && value <= state.notificationSettings.expiryDaysBefore; });
  const shopping = getShoppingItems(state);
  const modal = createModal(`<div class="modal-heading"><p class="eyebrow">REMINDERS</p><h2>今天的提醒</h2></div><div class="notification-list"><button data-tab-target="inventory"><span class="notify-icon pink">${icon('clock')}</span><span><strong>${urgent.length} 项食材需要留意日期</strong><small>${urgent.map((item) => item.name).join('、') || '暂无临期食材'}</small></span></button><button data-tab-target="recipe"><span class="notify-icon green">${icon('spark')}</span><span><strong>${state.notificationSettings.planningTime} 看看今日推荐</strong><small>也可以随时进入“此刻想法”定制</small></span></button><button data-tab-target="shopping"><span class="notify-icon blue">${icon('cart')}</span><span><strong>${shopping.length} 项采购提醒</strong><small>来自菜谱缺口和必备食材</small></span></button></div>`);
  modal.querySelectorAll('[data-tab-target]').forEach((button) => button.addEventListener('click', () => { modal.remove(); navigateView({ activeTab: button.dataset.tabTarget }); }));
}

function createModal(content, size = '') {
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop'; backdrop.innerHTML = `<div class="modal ${size}" role="dialog" aria-modal="true"><button class="modal-close" data-close aria-label="关闭">${icon('close')}</button><div class="modal-body">${content}</div></div>`; document.body.append(backdrop);
  backdrop.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => backdrop.remove()));
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdrop.remove(); });
  return backdrop;
}

function notify(message) { store.set({ notice: message }); window.setTimeout(() => { if (store.get().notice === message) store.set({ notice: null }); }, 2800); }

function startNotificationScheduler() {
  if (notificationTimer) return; notificationTimer = window.setInterval(checkScheduledNotifications, 60000); checkScheduledNotifications();
}

async function checkScheduledNotifications() {
  const state = store.get(); const settings = state.notificationSettings; if (!settings.enabled) return;
  const now = new Date(); const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; let message = '';
  const pendingPlan = nextPlanForReview(state.plannedMeals, now);
  if (settings.dailyRecipe && currentTime === settings.planningTime) message = '今天的食谱灵感已经准备好了';
  if (settings.mealReviewMode === 'fixed_time' && state.pendingMealReviews.length && currentTime === settings.fixedReviewTime) message = `有 ${state.pendingMealReviews.length} 顿饭等待确认食材消耗`;
  if (pendingPlan && !pendingPlan.reminderSentAt) message = pendingPlan.status === 'awaiting_review' ? `「${pendingPlan.recipe.recipeName}」还在等待核对实际用量` : `今天计划的「${pendingPlan.recipe.recipeName}」做了吗？`;
  const key = `${now.toDateString()}-${currentTime}-${message}`;
  if (message && key !== lastNotificationKey) {
    lastNotificationKey = key;
    if (Notification.permission === 'granted') new Notification('FreshLoop', { body: message }); else notify(message);
    // Real accounts queue the selected-meal SMS when “今天想做” is saved.
    // Avoid sending the same plan reminder again from an open browser tab.
    const planSmsAlreadyQueued = Boolean(pendingPlan && hasRemoteAuth() && state.auth.session?.access_token);
    if (!planSmsAlreadyQueued && settings.smsConsent && ['sms', 'both'].includes(settings.channel) && state.profile.phone) sendReminderSms({ phone: state.profile.phone, message: `FreshLoop：${message}`, session: state.auth.session }).catch(() => notify('应用内提醒已送达；短信服务暂不可用'));
    if (pendingPlan) store.update((next) => { const plan = next.plannedMeals.find((item) => item.id === pendingPlan.id); if (plan) plan.reminderSentAt = now.toISOString(); });
  }
}

store.subscribe(render);
navigateView(viewSnapshot(), { replace: true });
startNotificationScheduler();
const bootState = store.get();
if (bootState.auth?.authenticated && bootState.auth?.onboardingComplete && !bootState.dailyRecommendations.length) refreshDailyRecommendations();

