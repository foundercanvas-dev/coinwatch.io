# Deploying Coinwach.io on Render (100% Free)

This project is configured with a native Render Blueprint (`render.yaml`) and a multi-stage `Dockerfile`.

## Why Render Frankfurt?
By deploying in the **Frankfurt (Germany)** region, your backend gets a clean European IP where **Binance, Bybit, OKX, and Hyperliquid** public WebSockets connect with HTTP 200 (no Cloudflare geo-blocking or 403 errors).

---

## 1-Click Setup via Render Blueprint

1. **Push your code to GitHub**:
   ```bash
   git add -A
   git commit -m "Configure Render Blueprint and multi-stage Dockerfile"
   git push origin main
   ```

2. **Go to Render**:
   - Open [dashboard.render.com](https://dashboard.render.com).
   - Click **New +** ➔ **Blueprint**.
   - Connect your GitHub repository (`coinwatch.io`).

3. **Deploy**:
   - Render will automatically detect `render.yaml`.
   - Click **Apply**.
   - Render installs requirements, builds the Vite frontend, starts FastAPI with Uvicorn, and gives you a free HTTPS live URL (e.g. `https://coinwatch.onrender.com`).

---

## Service Specifications in `render.yaml`
- **Type**: Web Service
- **Runtime**: Python 3.11 + Node 20
- **Plan**: `free`
- **Region**: `frankfurt`
- **Build Command**: `npm install && npm run build && pip install -r backend/requirements.txt`
- **Start Command**: `uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT`
- **Mounted Frontend**: Built React Vite SPA is automatically served at `/` alongside REST API `/api/*` and WebSocket `/ws/scanner`.
