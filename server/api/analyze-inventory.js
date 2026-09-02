import { callDeepSeek, parseRequestBody, sendError } from './_deepseek.js';
import { normalizeVisionCandidates } from '../../src/services/visionCandidates.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  try {
    const { source = 'photo', image, interfaceLanguage = 'zh-CN' } = parseRequestBody(request);
    if (!image || !String(image).startsWith('data:image/')) return response.status(400).json({ error: 'A base64 image data URL is required' });
    const result = await callDeepSeek({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [
        {
          role: 'system',
          content: `你是严格的食材与超市小票视觉识别器，只输出 JSON。所有候选必须直接由图片中可见的商品外形、包装文字、小票行项目或数量证据支持；禁止补全“常见搭配”，禁止凭空添加，无法辨认就不输出。输出 {"candidates": Candidate[]}，candidates 与 storageOptions 都必须是 JSON 数组，禁止改成对象或字符串。Candidate 必须包含 name, normalizedName, category, uiCategory(protein|produce|staple|condiment|other), suggestedManagementMode(tracked_quantity|freshness_only|approximate_stock), quantity, unit, packageState(opened|sealed|unknown), storageLocation, storageOptions, expiryRequired, confidence(0到1), needsUserReview, visualEvidence。界面字段必须使用最简单、最通用的中文：name 只写食材通用名，不保留品牌、产地、等级、认证、有机、规格或英文包装全称，例如“Certified Organic Coriander”写“香菜”，“English Parsley”写“欧芹”；category、unit、storageLocation 和所有 note 也必须使用简体中文，单位只用“克、千克、个、颗、根、把、袋、盒、瓶、包、毫升、升、份”等短标签，禁止输出 bun、pack、pcs 等英文单位。normalizedName 可保留稳定的英文标准名。可按盒、块、个、袋计数或能估算克重的食材（包括豆腐）必须使用 tracked_quantity；freshness_only 只用于用户通常不会逐次记录余量的整件食品。照片候选还应给 normalizedBox:{x,y,width,height}，坐标均为0到1000的整数；小票候选的 visualEvidence 必须包含可见行文字。storageOptions 必须严格包含冷藏、冷冻、常温三项，每项为 {location,days,available,note}。所有食材都必须生成或要求用户填写最佳品质提醒日；包装食品（包括主食和调味品）将 expiryRequired 设为 true。蚝油若已开封应冷藏，常温不得与冷藏套用相同天数；看不清是否开封时 packageState=unknown 且 needsUserReview=true。confidence 低于0.65的项目不要输出。不要输出 Markdown。`
        },
        {
          role: 'system',
          content: interfaceLanguage === 'en'
            ? 'The user selected English. Override the earlier Chinese-display-field rule: write name, category, unit and every user-facing note in concise plain English. Use only generic ingredient names without brands, origin, grade, certification, organic claims or pack-size marketing. Keep storageLocation as the stable Chinese enum required by the application schema, and keep normalizedName as stable English.'
            : '用户选择简体中文。所有面向用户的识别名称、分类、单位和说明必须使用最简单的中文短标签，不保留品牌与营销修饰。'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `请识别这张${source === 'receipt' ? '购物小票' : '食材合照'}并输出 JSON 确认清单。` },
            { type: 'image_url', image_url: { url: image, detail: 'original' } }
          ]
        }
      ],
      maxTokens: 6500
    });
    const candidates = normalizeVisionCandidates(result.candidates, interfaceLanguage).filter((candidate) => {
      const confidence = Number(candidate.confidence);
      return candidate.name && candidate.normalizedName && candidate.visualEvidence && Number.isFinite(confidence) && confidence >= 0.65;
    });
    if (!candidates.length) return response.status(422).json({ error: '视觉模型没有找到置信度足够高的食材；请上传更清晰、光线更均匀的图片' });
    return response.status(200).json({ candidates, model: 'deepseek-v4-flash-vision-exp', promptVersion: 'capture-v5-grounded-vision', generatedAt: new Date().toISOString() });
  } catch (error) {
    return sendError(response, error);
  }
}
