const INTERNAL_REPLY = '小吉不是很清楚，請之後再詢問';

const BOT_REFERENCE = /(?:小吉|這個(?:機器人|網站|系統)|此(?:機器人|網站|系統)|bot\b|your\s+bot|(?:你|妳)(?:的|們的|是|用|使用|採用|部署|開發|製作|架設|目前|現在|下一版|下個版本|會|有|後端|技術))/i;
const INTERNAL_SUBJECT = /(?:內部|機密|原始碼|源碼|程式碼|模型|model\b|api\s*key|access\s*token|存取權杖|密鑰|金鑰|憑證|提示詞|prompt|系統指令|測試資料|測試紀錄|開發(?:日誌|紀錄|記錄|過程|者)|使用日誌|伺服器(?:詳細|位置|設定|規格)|主機(?:設定|位置)|資料庫(?:結構|種類)|技術(?:架構|棧|細節)|框架|套件|部署|架設|怎麼做出來|如何做出來|用什麼寫|未發布|下一版|下個版本|未來版本|版本規劃|roadmap|source\s*code|system\s*prompt|訓練資料)/i;
const PUBLIC_VERSION_QUERY = /(?:目前|現在|已發布|正式|最新)(?:的)?版本|版本(?:是多少|號|資訊)|release\s*(?:link|連結)?/i;
const FUTURE_VERSION_QUERY = /(?:下一版|下個版本|未發布|開發中|未來版本|版本規劃|roadmap)/i;
const IMPLIED_BOT_INTERNAL_QUESTION = /^(?:(?:你|妳)?用(?:了|的是)?什麼(?:框架|技術|模型|資料庫)|目前(?:的)?技術棧|開發(?:紀錄|記錄|日誌)(?:在)?哪裡|部署(?:在)?哪裡|下一版(?:的)?(?:規劃|功能|內容))/i;
const SELF_IMPLEMENTATION = /(?:小吉|你|妳)(?:的)?(?:用|由|以|靠)(?:[^。！？\n]{0,45})(?:開發|提供服務|運行|執行|當資料庫|作為資料庫)/i;

function requestsInternalDetails(value) {
  // 開頭的「小吉，」是稱呼；後面才是問題的主詞。
  const text = String(value || '').normalize('NFKC').trim().replace(/^小吉\s*[，,:：]\s*/, '');
  if (IMPLIED_BOT_INTERNAL_QUESTION.test(text)) return true;
  if (!BOT_REFERENCE.test(text)) return false;
  if (PUBLIC_VERSION_QUERY.test(text) && !INTERNAL_SUBJECT.test(text.replace(PUBLIC_VERSION_QUERY, ''))) return false;
  return FUTURE_VERSION_QUERY.test(text) || INTERNAL_SUBJECT.test(text) || SELF_IMPLEMENTATION.test(text) ||
    /(?:製作過程|怎麼寫出來|測試結果)/.test(text);
}

function containsInternalDisclosure(value) {
  const text = String(value || '');
  const configuredSecrets = [process.env.DISCORD_TOKEN, process.env.OPENAI_API_KEY, process.env.GROQ_API_KEY]
    .map((item) => String(item || '').trim()).filter(Boolean);
  if (configuredSecrets.some((secret) => text.includes(secret))) return true;
  if (/(?:gsk|sk)-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,}|C:\\Users\\|\/home\/container\/|\b(?:BOT_OWNER_ID|DISCORD_TOKEN|OPENAI_API_KEY|GROQ_API_KEY)\b/i.test(text)) return true;
  if (/(?:我|小吉)(?:目前|現在)?部署(?:在|於)|(?:我|小吉)(?:的)?(?:後端框架|資料庫|技術棧|模型|部署位置|開發(?:紀錄|記錄|日誌))(?:是|為|在|使用|採用|位於)|(?:^|[。！？\n])\s*(?:後端框架|部署位置|開發(?:紀錄|記錄|日誌))(?:是|為|在)/i.test(text)) return true;
  const selfOrImpliedDeployment = /(?:我是|我(?:的|用|由|使用|採用|基於|透過|部署)|小吉(?:是|用|由|使用|採用|透過|基於|部署|的)|(?:後端框架|資料庫|技術棧|部署位置|主機)(?:是|為|使用|採用)|(?:^|[。！？\n])\s*部署在)/i;
  const internalDetail = /(?:GPT|Claude|Gemini|OpenAI|Groq|discord\.js|Node\.js|SQLite|PostgreSQL|Postgres|Redis|Express|雲端主機|模型名稱|系統提示詞|開發(?:日誌|紀錄|記錄)|內部測試資料|未發布|下一版|版本規劃)/i;
  return text.split(/[。！？\n]/).some((sentence) =>
    selfOrImpliedDeployment.test(sentence) && internalDetail.test(sentence));
}

module.exports = { INTERNAL_REPLY, requestsInternalDetails, containsInternalDisclosure };
