import { callDeepSeek, parseRequestBody, sendError } from './_deepseek.js';
import { retrieveRecipeContext } from '../rag/recipeKnowledge.js';
import { retrieveXiachufangCandidates } from '../rag/xiachufang.js';

const CONDIMENTS = new Set(['soy sauce', 'cooking oil', 'oyster sauce', 'salt', 'sugar', 'cornstarch', 'rice vinegar', 'vinegar', 'black pepper', 'white pepper', 'garlic', 'ginger', 'scallion', 'fresh chili', "bird's eye chili", 'dried chili', 'pickled chili', 'chili oil', 'chili bean paste', 'sesame oil', 'cooking wine', 'water']);
const STAPLES = new Set(['rice', 'noodle', 'bread', 'potato', 'sweet potato', 'corn', 'dumpling']);

function isSpicyRequest(text = '') {
  return /麻辣|香辣|酸辣|辣椒|小米辣|辣一点|微辣|中辣|重辣|想吃辣|要辣|辣/.test(text) && !/不要辣|不吃辣|不能吃辣|不辣/.test(text);
}

function isNamedDishRequest(text = '') {
  return /宫保|鱼香|麻婆|水煮|回锅|红烧|咖喱|冬阴功|叻沙|佛跳墙|口水鸡|辣子鸡|酸菜鱼|锅包肉|炖牛肉|煲仔饭/.test(text);
}

function isCookingInventory(item) {
  const expiry = item.expiryDate ? new Date(`${item.expiryDate}T23:59:59`) : null;
  const expired = expiry && Number.isFinite(expiry.getTime()) && expiry < new Date();
  return !expired && !['staple', 'other', 'condiment'].includes(item.uiCategory) && !['milk', 'yogurt'].includes(item.canonicalName);
}

function coreCount(recipe) {
  return (recipe.ingredients || []).filter((item) => !STAPLES.has(item.canonicalName) && !CONDIMENTS.has(item.canonicalName)).length;
}

function hasChili(recipe) {
  return (recipe.ingredients || []).some((item) => /chili/.test(item.canonicalName || '') || /辣椒|小米辣|泡椒|干辣椒/.test(item.name || ''));
}

function normalizeSteps(value, fallback = []) {
  const text = (item) => {
    if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
    if (item && typeof item === 'object') return Object.values(item).filter((part) => typeof part === 'string' || typeof part === 'number').map(String).join(' · ').trim();
    return '';
  };
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === 'string') return value.split(/\n+|(?=\d+[.、）)])/).map((item) => item.replace(/^\d+[.、）)]\s*/, '').trim()).filter(Boolean);
  return fallback;
}

function cleanRecipeName(value = '') {
  return String(value || '')
    .replace(/^\s*(?:\d+[.、:：\-]\s*|第[一二三四五六七八九十\d]+道\s*)/, '')
    .trim();
}

function xiachufangQueries(selected, cookingInventory) {
  const items = (selected.length ? selected : cookingInventory).map((item) => item.name).filter(Boolean);
  const queries = [items.slice(0, 2).join(' '), items.slice(2, 4).join(' ')].filter(Boolean);
  return queries.length ? queries : ['家常菜'];
}

const DISH_METHODS = ['炒', '汤', '炖', '焖', '煎', '烤', '蒸', '拌', '面', '饭', '粥', '饼', '烩', '炸', '沙拉'];

function bestWebReference(recipe, candidates, usedIds) {
  const recipeName = String(recipe.recipeName || '');
  const recipeIngredients = (recipe.ingredients || []).map((item) => String(item.name || '')).filter(Boolean);
  const recipeMethods = DISH_METHODS.filter((method) => recipeName.includes(method));
  const ranked = candidates.filter((candidate) => !usedIds.has(candidate.id)).map((candidate) => {
    const searchable = `${candidate.title} ${(candidate.ingredients || []).join(' ')}`;
    const candidateMethods = DISH_METHODS.filter((method) => candidate.title.includes(method));
    const methodMatch = recipeMethods.length && candidateMethods.length ? recipeMethods.some((method) => candidateMethods.includes(method)) : false;
    const methodConflict = recipeMethods.length && candidateMethods.length && !methodMatch;
    const ingredientOverlap = recipeIngredients.filter((name) => searchable.includes(name) || (candidate.ingredients || []).some((item) => name.includes(item) || item.includes(name))).length;
    const titleMatch = candidate.title.includes(recipeName) || recipeName.includes(candidate.title);
    return { candidate, score: (titleMatch ? 8 : 0) + ingredientOverlap * 2 + (methodMatch ? 3 : 0) - (methodConflict ? 5 : 0) };
  }).sort((a, b) => b.score - a.score || b.candidate.score - a.candidate.score);
  return ranked[0]?.score >= 5 ? ranked[0].candidate : null;
}

function ensureRequiredChili(recipe, index, servings) {
  if (hasChili(recipe)) {
    return {
      ...recipe,
      ingredients: (recipe.ingredients || []).map((item) => ({
        ...item,
        userIntentRequired: /chili/.test(item.canonicalName || '') || /辣椒|小米辣|泡椒|干辣椒/.test(item.name || '')
      }))
    };
  }
  const choices = [
    { canonicalName: 'fresh chili', name: '鲜辣椒', requiredAmount: servings, unit: '根' },
    { canonicalName: "bird's eye chili", name: '小米辣', requiredAmount: servings * 2, unit: '根' },
    { canonicalName: 'dried chili', name: '干辣椒', requiredAmount: servings * 3, unit: '根' },
    { canonicalName: 'pickled chili', name: '泡椒', requiredAmount: servings * 2, unit: '根' }
  ];
  const chili = choices[index % choices.length];
  return { ...recipe, ingredients: [...(recipe.ingredients || []), { ...chili, userIntentRequired: true }], steps: [...(recipe.steps || []), `加入${chili.name}并炒出辣香，分两次调节用量，确保成品真正有辣味。`] };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  try {
    const { input = {}, inventory = [], profile = {}, count = 4, history = [] } = parseRequestBody(request);
    const hardConstraints = { allergies: profile.allergies || [], dislikes: profile.dislikes || [], dietaryConstraints: profile.dietaryConstraints || [] };
    const tasteProfile = { tasteTags: profile.tasteTags || [], cuisineTags: profile.cuisineTags || [], notes: profile.tasteNotes || '', summary: profile.tasteProfileSummary || '' };
    const cookingInventory = inventory.filter(isCookingInventory);
    const selected = cookingInventory.filter((item) => (input.selectedIngredientIds || []).includes(item.id));
    const condiments = inventory.filter((item) => item.uiCategory === 'condiment');
    const carb = inventory.find((item) => item.id === input.carbId && item.uiCategory === 'staple') || null;
    const requestText = `${input.prompt || ''} ${input.followUp || ''}`.trim();
    const spicyRequired = isSpicyRequest(requestText);
    const namedDish = isNamedDishRequest(requestText);
    const retrievedContext = retrieveRecipeContext({ input, inventory: cookingInventory, profile });
    const retrievedIds = new Set(retrievedContext.map((item) => item.id));
    const webCandidates = await retrieveXiachufangCandidates(xiachufangQueries(selected, cookingInventory));
    const webCandidateMap = new Map(webCandidates.map((item) => [item.id, item]));
    const result = await callDeepSeek({
      messages: [
        {
          role: 'system',
          content: `你是面向新加坡家庭厨房新手的菜谱规划助手，只输出 JSON。你必须根据本次传入的库存、口味画像、用户此刻想法和检索知识卡现场创造菜谱，禁止复述固定模板。优先级从高到低：1. 过敏、明确忌口与饮食限制；2. 用户此刻明确提出的味道、菜式与时间；3. 长期口味画像；4. 库存便利。用户写“辣、微辣、香辣”等时，这是硬标准，返回的每一道菜都必须明确包含一种真正的辣椒（鲜辣椒、小米辣、干辣椒或泡椒），写出准确数量和加入时机；库存没有也不能弱化成不辣。默认恰好返回 4 道互不重复的菜：前 2 道 planType=pantry，核心食材尽量来自库存；后 2 道 planType=explore，只允许少量补齐核心食材。每道菜最多 3 种核心食材，主食和葱姜蒜、辣椒、油、盐、酱料等调味不计入核心食材。调味料必须尽量只用“调味库存”；整组默认最多只有 1 道菜缺 1 种调味料。只有用户明确点名的菜式或明确味道标准确实需要时，才允许超出该调味缺口上限，并在 reason 中说明。不得把主食、饮料、零食、牛奶或酸奶放入“优先库存”，也不要生成饮品或零食。指定主食必须在四道菜中使用；未指定则可不配主食。备餐时间 240 表示允许 2 小时以上的炖煮。每道菜从锅具、预热、食用油毫升数、火力和秒/分钟数开始教；prep 恰好 2–3 条，steps 恰好 5–7 条，tips 最多 2 条，在紧凑篇幅内写全准确调味用量、预处理、加入顺序、熟度判断与失败补救。输出对象必须是 {"recipes": Recipe[]}，Recipe 包含 id, recipeName, imageSearchQuery, emoji, estimatedPrepMinutes, servings, reason, planType, planLabel, ragEvidenceIds, ingredients, prep, steps, tips；imageSearchQuery 只写 2–4 个英文词，优先“主要食材 + 菜式”，用于开放图库搜索；ragEvidenceIds 必须引用本次提供的知识卡 id。ingredients 包含 canonicalName, name, requiredAmount, unit。不要输出 Markdown。`
        },
        {
          role: 'system',
          content: `以下是从下厨房公开搜索页提取的精简候选，仅包含菜名、主要食材、评分、来源链接，不含可复制的完整步骤：${JSON.stringify(webCandidates.map(({ id, title, ingredients, score, cooks, sourceUrl }) => ({ id, title, ingredients, score, cooks, sourceUrl })))}。候选仅用于菜式身份、用户画像筛选和配图匹配。若采用某候选，必须保持同一道菜的核心食材和烹饪形态，并在 Recipe 增加 webReferenceId=候选 id；若没有准确匹配则 webReferenceId=null。不得照抄第三方步骤。recipeName 不得带“1.”、“第一道”等任何序号。imageSearchQuery 要同时体现主要食材、烹饪形态和成品浓淡色泽。`
        },
        {
          role: 'user',
          content: `请生成恰好 4 道菜。\n本次刷新标识：${input.generationNonce || 'initial'}，需要与之前结果明显不同。\n用户此刻想法（硬标准，仅次于过敏忌口）：${input.prompt || '没有额外指定'}\n补充追问：${input.followUp || '无'}\n是否必须每道都有辣椒：${spicyRequired ? '是' : '否'}\n是否点名具体菜式：${namedDish ? '是，可在确有必要时解释调味例外' : '否'}\n人数：${input.servings || 1}\n备餐上限：${input.prepTime || 30} 分钟\n口味画像：${JSON.stringify(tasteProfile)}\n指定主食：${carb ? JSON.stringify({ name: carb.name, canonicalName: carb.canonicalName, unit: carb.unit }) : '无'}\n本次抽取的优先核心食材：${JSON.stringify(selected.map(({ id, name, canonicalName, quantity, unit, expiryDate }) => ({ id, name, canonicalName, quantity, unit, expiryDate })))}\n可入菜核心库存（已排除主食、其他食品、调味料、牛奶和酸奶）：${JSON.stringify(cookingInventory.map(({ id, name, canonicalName, quantity, unit, expiryDate }) => ({ id, name, canonicalName, quantity, unit, expiryDate })))}\n调味库存：${JSON.stringify(condiments.map(({ name, canonicalName, stockPercentage, quantity, unit }) => ({ name, canonicalName, stockPercentage, quantity, unit })))}\n检索到的烹饪知识卡：${JSON.stringify(retrievedContext)}\n硬约束：${JSON.stringify(hardConstraints)}\n不得重复的近期方案：${JSON.stringify(history.slice(-8).map(({ recipeName, reason }) => ({ recipeName, reason })))}`
        }
      ],
      maxTokens: 4000,
      temperature: 0.72
    });

    let recipes = (result.recipes || []).slice(0, 4);
    if (spicyRequired) recipes = recipes.map((recipe, index) => ensureRequiredChili(recipe, index, Number(input.servings || 1)));
    const usedWebReferenceIds = new Set();
    recipes = recipes.map((recipe, index) => {
      const requestedReference = webCandidateMap.get(String(recipe.webReferenceId || '')) || null;
      const webReference = requestedReference && !usedWebReferenceIds.has(requestedReference.id)
        ? requestedReference
        : bestWebReference(recipe, webCandidates, usedWebReferenceIds);
      if (webReference) usedWebReferenceIds.add(webReference.id);
      return {
        ...recipe,
        id: recipe.id != null && recipe.id !== '' ? String(recipe.id) : `remote-${Date.now()}-${index}`,
        recipeName: cleanRecipeName(recipe.recipeName) || `${(recipe.ingredients || []).slice(0, 2).map((item) => item.name).filter(Boolean).join('')}家常菜`,
        planType: index < 2 ? 'pantry' : 'explore',
        planLabel: index < 2 ? '尽量用现有库存' : '只补少量新食材',
        coreIngredientCount: coreCount(recipe),
        prep: normalizeSteps(recipe.prep, ['清洗并按步骤切配食材。']),
        steps: normalizeSteps(recipe.steps, ['按食材熟成速度依次下锅，完成后立即装盘。']),
        tips: normalizeSteps(recipe.tips),
        ragEvidenceIds: (recipe.ragEvidenceIds || []).filter((id) => retrievedIds.has(id)),
        retrievalContext: retrievedContext.map(({ id, title }) => ({ id, title })),
        webReference: webReference ? { id: webReference.id, title: webReference.title, sourceUrl: webReference.sourceUrl } : null,
        image: webReference ? {
          url: webReference.imageUrl,
          sourceUrl: webReference.sourceUrl,
          title: webReference.title,
          artist: '',
          license: '菜谱图片参考 · 下厨房',
          provider: '下厨房',
          matchedQuery: webReference.query,
          policyVersion: 'xiachufang-reference-v1'
        } : null,
        createdAt: new Date().toISOString(),
        model: 'deepseek-v6-web-rag',
        promptVersion: 'recipe-v6-xiachufang-reference'
      };
    });
    if (recipes.length !== 4) throw new Error('Model returned an incomplete four-recipe set');
    if (new Set(recipes.map((recipe) => recipe.recipeName)).size !== recipes.length) throw new Error('Model returned duplicate recipes');
    if (recipes.some((recipe) => recipe.coreIngredientCount > 3)) throw new Error('Model exceeded the three-core-ingredient limit');
    if (spicyRequired && recipes.some((recipe) => !hasChili(recipe))) throw new Error('Model did not honor the chili requirement');
    return response.status(200).json({
      recipes,
      retrievalContext: retrievedContext.map(({ id, title }) => ({ id, title })),
      webRetrieval: { source: 'xiachufang.com', candidateCount: webCandidates.length },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return sendError(response, error);
  }
}
