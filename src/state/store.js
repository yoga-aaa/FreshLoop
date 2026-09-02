import { DEMO_INVENTORY, DEMO_PROFILE } from '../data/demo.js';
import { buildPlanReviewAt } from '../services/planning.js';

const STORAGE_KEY = 'freshloop-demo-state-v4';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrateInventory(items = []) {
  return items.map((item) => {
    const isTofu = item.canonicalName === 'tofu' || /豆腐/.test(item.name || '');
    if (!isTofu || item.managementMode !== 'freshness_only') return item;
    return {
      ...item,
      managementMode: 'tracked_quantity',
      quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
      unit: item.unit || '盒',
      stockPercentage: null
    };
  });
}

function initialState() {
  return {
    auth: {
      authenticated: false,
      onboardingComplete: false,
      stage: 'phone',
      phone: '',
      session: null,
      demoMode: false
    },
    activeTab: 'inventory',
    inventory: clone(DEMO_INVENTORY),
    profile: clone(DEMO_PROFILE),
    recipes: [],
    dailyRecommendations: [],
    dailyRecommendationError: null,
    aiGenerationMode: 'remote_required',
    selectedRecipeId: null,
    recipeMode: 'feed',
    favorites: [],
    mealLogs: [],
    pendingMealReviews: [],
    plannedMeals: [],
    shoppingItems: [],
    shoppingDismissed: [],
    inventoryQuery: '',
    inventoryCategory: 'all',
    inventoryStorage: 'all',
    inventoryManageMode: false,
    expiredPromptHandled: [],
    notificationSettings: {
      enabled: false,
      expiry: true,
      expiryDaysBefore: 3,
      dailyRecipe: true,
      planningTime: DEMO_PROFILE.planningTime,
      mealReviewMode: DEMO_PROFILE.mealReviewMode,
      afterMealHours: DEMO_PROFILE.afterMealHours,
      fixedReviewTime: DEMO_PROFILE.fixedReviewTime,
      planConfirmationTime: '21:30',
      channel: 'app',
      smsConsent: false
    },
    notice: null,
    isGenerating: false,
    planningInput: {
      prompt: '',
      servings: DEMO_PROFILE.defaultServings,
      prepTime: DEMO_PROFILE.defaultPrepTime,
      selectedIngredientIds: ['ing-002', 'ing-004'],
      carbId: 'ing-008',
      followUp: ''
    }
  };
}

function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialState();
    const merged = { ...initialState(), ...JSON.parse(saved) };
    merged.inventory = migrateInventory(merged.inventory);
    const isRealModelResult = (recipe) => recipe?.model && recipe.model !== 'curated-local' && !String(recipe.promptVersion || '').includes('local');
    merged.recipes = (merged.recipes || []).filter(isRealModelResult);
    merged.dailyRecommendations = (merged.dailyRecommendations || []).filter(isRealModelResult);
    merged.activeTab = 'inventory';
    merged.recipeMode = 'feed';
    merged.isGenerating = false;
    merged.inventoryQuery = '';
    merged.inventoryCategory = 'all';
    merged.inventoryStorage = 'all';
    merged.aiGenerationMode = 'remote_required';
    merged.plannedMeals = (merged.plannedMeals || []).map((plan) => ({
      ...plan,
      status: plan.status === 'made' ? 'awaiting_review' : plan.status,
      reviewAt: plan.reviewAt || buildPlanReviewAt(plan.plannedFor, plan.confirmationTime || merged.notificationSettings.planConfirmationTime, new Date(0))
    }));
    return merged;
  } catch {
    return initialState();
  }
}

let state = load();
const listeners = new Set();

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export const store = {
  get() { return state; },
  set(patch, options = {}) {
    state = { ...state, ...patch };
    persist();
    if (!options.silent) listeners.forEach((listener) => listener(state));
  },
  update(mutator) {
    const next = clone(state);
    mutator(next);
    state = next;
    persist();
    listeners.forEach((listener) => listener(state));
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  reset() {
    state = initialState();
    persist();
    listeners.forEach((listener) => listener(state));
  }
};
