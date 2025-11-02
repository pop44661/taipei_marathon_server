// 說明：Express 後端（無語音版）
// 提供靜態前端 + API：/api/chat
// 需求：Node 18+ (原生 fetch)、dotenv、express、cors

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

const REDIS_TTL_SECONDS = 3600; // 快取結果的存活時間 (TTL)，設定為 1 小時
const client = createClient();
    
client.on('error', (err) => console.error('🔴 Redis 連線錯誤:', err));

try {
    await client.connect();
    console.log('✅ Redis 客戶端連線成功');
} catch (e) {
    console.error('❌ 無法連線到 Redis:', e.message);
    // 如果連線失敗，讓應用程式繼續運行，但 API 請求會失敗
}

/* =========================
   CORS（允許 GitHub Pages 來源）
   ========================= */
app.use(cors({
  origin: ['https://taipei-marathon.smartchat.live','https://justin-321-hub.github.io','https://taipei-marathon-english.smartchat.live','https://taipei-marathon-japan.smartchat.live','https://pop44661.github.io'],
  methods: ['GET', 'POST', 'OPTIONS'],
  // 保留 X-Client-Id 供多使用者識別
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  maxAge: 86400
}));
app.options('*', cors());

/* =========================
   通用中介層
   ========================= */
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* 健康檢查 */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* =========================
   n8n 代理：文字 → 你的 n8n Webhook
   ========================= */
app.post('/api/chat/start', async (req, res) => {
    // 1.1. 生成唯一的請求 ID (Request ID)
    const requestID = Date.now().toString(36) + Math.random().toString(36).substring(2);
    
    const cid = req.body?.clientId || req.headers['x-client-id'] || 'anon';
    
    // 1.2. 構造傳給 N8N 的數據
    const payload = {
        ...(req.body || {}), // 終端用戶傳來的數據
        clientId: cid, // 將 clientId 合併進 body，避免前端漏傳
        requestID: requestID, // 用於追蹤結果的 ID
        callbackURL: `${SERVER_BASE_URL}/api/chat/callback` // 告知 N8N 結果要發送到哪裡
    };

    // 1.3. 將初始狀態存入 Redis (status: processing)
    const initialData = { status: 'processing', timestamp: Date.now() };
    try {
        // 使用 SET key value EX seconds 指令，設定 1 小時後自動過期
        await client.set(requestID, JSON.stringify(initialData), { EX: REDIS_TTL_SECONDS });
        console.log(`[START] 請求 ID: ${requestID} 已在 Redis 中設置為 processing`);
    } catch (err) {
        console.error(`[START] Redis 寫入失敗: ${err}`);
        return res.status(502).json({
          error: 'Upstream fetch failed',
          detail: err?.message || String(err)
        });
    }


    try {
        
        const url = process.env.N8N_WEBHOOK_URL;
        if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL' });

        // 讀取 clientId（body 優先，其次 header），預設 anon
        

        // 1.4. 將請求發送給 N8N Webhook URL
        const n8nResponse = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // 某些 WAF/Cloudflare 對沒有 UA 的請求會擋
              'User-Agent': 'fourleaf-proxy/1.0',
              // 將 clientId 也轉傳到上游
              'X-Client-Id': cid
            },
            body: JSON.stringify(payload)
        });

        // 1.5. N8N 立即回覆 202 Accepted 或 200 OK
        if (n8nResponse.status === 202 || n8nResponse.status === 200) {
            // 1.6. 立即回覆給前端，並帶上 requestID
            return res.status(202).json({
                message: '請求已接受，正在後台處理中。',
                status: 'processing',
                requestID: requestID // 🚀 前端需要這個 ID 才能進行輪詢！
            });
        } else {
            // 如果 N8N 回覆失敗，可能需要刪除剛才存入 Redis 的 ID
            await client.del(requestID);
            return res.status(502).json({
              error: 'Upstream fetch failed',
              detail: `N8N 服務錯誤，HTTP 狀態碼: ${n8nResponse.status}` 
            });
        }
        
    } catch (err) {
        console.error('發送給 N8N 失敗:', err?.name, err?.message, err?.cause?.code);
        // 發送失敗也應刪除 Redis 中的 ID
        await client.del(requestID);
        return res.status(502).json({
          error: 'Upstream fetch failed',
          detail: err?.message || String(err)
        });
    }
});

app.post('/api/chat/callback', async (req, res) => {

    const { requestID, clientId, text } = req.body; 
        
    // 構造最終結果的 Payload
    const finalResult = {
        clientId: clientId, 
        text: text
    };
    
    if (requestID && finalResult) {
        // 2.1. 構造完成的結果數據
        const completedData = {
            status: 'completed',
            data: finalResult,
            timestamp: Date.now()
        };

        try {
            // 將結果儲存在 Redis 中，並更新狀態為 'completed'，同時保持 TTL
            await client.set(requestID, JSON.stringify(completedData), { EX: REDIS_TTL_SECONDS });
            console.log(`[CALLBACK] 請求 ID: ${requestID} 已在 Redis 中更新為 completed`);

            // 2.2. 回覆 N8N，表示結果已成功接收
            return res.status(200).send('Callback 成功接收');
        } catch (redisError) {
            console.error(`[CALLBACK] Redis 寫入失敗: ${redisError}`);
            return res.status(500).send('內部錯誤：無法儲存結果');
        }
    }

    return res.status(400).send('無效的 Callback 資料');
});

// 2.3. 前端用戶用來「輪詢 (Polling)」結果的 API 端點
app.get('/api/chat/result/:requestID', async (req, res) => {
    const { requestID } = req.params;
    let result = null;

    try {
        // 3.1. 從 Redis 取得結果 (JSON 字串)
        const resultString = await client.get(requestID);
        
        if (resultString) {
            result = JSON.parse(resultString);
        }
    } catch (redisError) {
        console.error(`[POLLING] Redis 讀取失敗: ${redisError}`);
        return res.status(500).json({ message: '內部錯誤：無法讀取結果' });
    }


    if (!result) {
        // 3.2. 如果 ID 不存在，可能是 ID 錯誤或結果已過期 (TTL) 或已被清除
        return res.status(404).json({ message: '請求 ID 不存在或已過期' });
    }

    if (result.status === 'completed') {
        // 3.3. 結果已完成，回傳數據
        // ⚠️【注意】回傳後應立即將 Redis 中的鍵刪除，以釋放資源
        try {
            await client.del(requestID); 
            console.log(`[POLLING] 請求 ID: ${requestID} 已完成並從 Redis 中刪除`);
        } catch (delError) {
              console.error(`[POLLING] Redis 刪除失敗: ${delError}`);
              // 這裡只印出錯誤，不影響回傳結果給前端
        }
        return res.status(200).json(result.data);
    }
    
    // 3.4. 結果尚未完成
    return res.status(200).json({ 
        status: 'processing', 
        message: '結果仍在處理中，請稍後再試。' 
    });
});

/* =========================
   （已移除）語音相關端點
   - /api/whisper  轉寫代理
   - /api/tts      文字轉語音
   相關套件/設定（multer、上傳限制等）也已移除
   ========================= */

/* =========================
   啟動服務
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);

});




