export function parseRequestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') return JSON.parse(request.body);
  return {};
}

export function parseModelJson(text = '') {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

export async function callDeepSeek({ model = 'deepseek-v4-flash', messages, maxTokens = 5000, temperature = 0.45, timeoutMs = 55000 }) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        stream: false
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('DeepSeek 生成超过 55 秒，已停止本次请求，请重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('DeepSeek API 密钥无效或已失效，请更新 .env.local 后重启本地服务');
    if (response.status === 402) throw new Error('DeepSeek 账户余额不足，请充值后重试');
    if (response.status === 429) throw new Error('DeepSeek 请求过于频繁，请稍后再试');
    if (response.status >= 500) throw new Error('DeepSeek 服务暂时繁忙，请稍后重试');
    throw new Error(`DeepSeek 请求失败（${response.status}）`);
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned an empty response');
  return parseModelJson(content);
}

export function sendError(response, error) {
  const status = /not configured/.test(error.message) ? 503 : 502;
  return response.status(status).json({ error: error.message });
}
