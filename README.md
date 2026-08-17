# FootStepCollector (足跡AR & マップ共有アプリケーション)

スマホ向けWebブラウザ（Android Chrome推奨）で動作する、リアルタイム位置同期型「足跡AR & マップ共有アプリケーション」のプロトタイプです。

## 🌟 主な機能と特徴

1. **歩行ルートの等間隔足跡サンプリング (Turf.js)**
   - `navigator.geolocation.watchPosition` でGPS座標を取得。
   - 移動距離を Turf.js (`turf.distance`) でリアルタイム監視し、0.8m間隔で `turf.lineString` と `turf.along` による等間隔補間を実行。
   - 左右の歩行ステップ（±0.18m の横方向オフセット）を付与し、リアルな足跡データを生成。

2. **リアルタイムデータ同期 & 密度計算 (Node.js / WebSocket)**
   - WebSocket (`ws`) を通じて全クライアント間で足跡データをリアルタイム共有。
   - サーバー側で近傍半径（2.5m以内）の通過回数・重複度をカウントし、`density`（密度）パラメータをリアルタイム計算してブロードキャスト。

3. **2Dマップ同期画面 (MapLibre GL JS)**
   - ダークテーマのベクター/ラスター地図上に、リアルタイムな現在地と進行方向（コンパス方位連動）を描画。
   - 蓄積された足跡をGeoJSONレイヤーとして描画し、`density` に応じてカラー（水色 → 紫 → ネオンローズ → ゴールド）およびサイズ・グローを動的に変化。

4. **WebXR ARカメラ画面 (Three.js + WebXR)**
   - Android ChromeのWebXR API (`immersive-ar`, `hit-test`) を利用し、現実空間の地面プレーンを自動検出。
   - セッション開始時のGPS座標を原点とし、各足跡の緯度経度を **ENU（East-North-Up）** ローカル座標系へ変換してThree.jsワールド空間に配置。
   - 地面プレーン上にプロシージャル足跡テクスチャ付きPlaneMeshを配置し、密度に応じてスケール・透明度・発光色を同期。

5. **デスクトップ / 室内用 GPSシミュレータ搭載**
   - 室内やPCブラウザでもすぐに動作検証できるよう、東西南北への移動ボタンおよび自動円周歩行（Auto Circle Walk）シミュレータをUIに標準装備。

---

## 🛠️ 技術スタック

- **フロントエンド:**
  - HTML5 / CSS3 (モダンガラスモフィズムUI, レスポンシブ)
  - JavaScript (ES6+)
  - **Three.js** (r128) - 3D/ARレンダリング
  - **WebXR Device API** (`immersive-ar`, `hit-test`, `dom-overlay`)
  - **MapLibre GL JS** (v4.7.1) - 2Dマップ表示
  - **Turf.js** (v7.1.0) - 地理空間計算・補間処理
- **バックエンド:**
  - **Node.js**
  - **Express** - 静的アセット配信
  - **ws** - WebSocket双方向リアルタイム通信

---

## 🚀 クイックスタート

### 1. 依存関係のインストール
```bash
npm install
```

### 2. サーバーの起動
```bash
npm start
```
起動すると、コンソールにアクセス用ポート（デフォルト: `http://localhost:3000` または空きポート）が表示されます。

---

## 📱 スマートフォン（Android Chrome）でのテスト手順（HTTPS環境）

> [!IMPORTANT]
> **WebXR (AR機能) および Geolocation API は、HTTPS (セキュアコンテキスト) でのみ動作します。**
> スマートフォン実機で動作させる際は、以下のいずれかのトンネリングツールをご利用ください。

### 方法A: ngrok を使用する場合（推奨・最速）

1. [ngrok](https://ngrok.com/) をインストール（未導入の場合）:
   ```bash
   npm install -g ngrok
   ```
2. ローカルサーバーのポート（例: 3000）をトンネリング:
   ```bash
   ngrok http 3000
   ```
3. 発行された `https://xxxx.ngrok-free.app` のURLをAndroidの Chrome ブラウザで開きます。

### 方法B: localtunnel を使用する場合
```bash
npx localtunnel --port 3000
```
発行された `https://xxxx.loca.lt` にスマホからアクセスします。

---

## 🎮 動作検証手順

1. **アクセス & パーミッション許可**
   - ブラウザでURLを開き、位置情報（GPS）およびモーションセンサーの利用を「許可」します。
2. **2Dマップでの足跡確認**
   - 実際に歩くか、画面下部の **「🧪 GPS Simulator」** パネルの「⬆️ North」「➡️ East」や「🚶 Auto Circle Walk」を押します。
   - 移動ルートに沿って 0.8m 間隔で足跡がマップ上に自動生成されます。
   - 同じ場所を何度も通過すると、足跡の `density` が上昇し、色が水色からローズ/ゴールドへと変化します。
3. **ARモードの起動**
   - **「👓 Enter AR Mode」** ボタンをタップします。
   - カメラが起動し、床や地面をゆっくりスキャンします。
   - 「✨ Ground Plane Locked」と表示されると、現実の床の上に自分の歩いた足跡が原寸大で3D表示されます。
   - 右上の「Exit AR」でいつでも2Dマップに戻ることができます。
4. **複数端末でのリアルタイム同期**
   - PCブラウザとスマートフォンの2台で同時に同じURLを開きます。
   - 一方で生成された足跡が、即座にもう一方の画面（2DマップおよびAR空間）にリアルタイム反映されます。
