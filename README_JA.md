# BigBanana AI Director (AI 漫劇工場)

> **AI 一站式 短編ドラマ／モーションコミック生成プラットフォーム**
> *Industrial AI Motion Comic & Video Workbench*

[![中文](https://img.shields.io/badge/Language-中文-gray.svg)](./README.md)
[![English](https://img.shields.io/badge/Language-English-gray.svg)](./README_EN.md)
[![日本語](https://img.shields.io/badge/Language-日本語-blue.svg)](./README_JA.md)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

**BigBanana AI Director** は、**AI 一站式の短編ドラマ／モーションコミックプラットフォーム**です。アイデアから完成動画までを高速に制作したいクリエイター向けに設計されています。

従来の「ガチャ」的な生成手法を捨て、**「脚本 -> アセット -> キーフレーム」** という産業用ワークフローを採用しています。複数モデルを柔軟に接続できる構成により、**「一文で完全な短編ドラマを生成し、脚本から完成動画までを全自動化」** しつつ、キャラクターの一貫性、シーンの連続性、そしてカメラワークの精密な制御を実現しました。

## UI ショーケース

### プロジェクト管理
![プロジェクト管理](./images/项目管理.png)

### Phase 01: 脚本とストーリーボード
![脚本作成](./images/剧本创作.png)
![脚本とストーリー](./images/剧本与故事.png)

### Phase 02: キャラクター・シーンアセット
![キャラクター・シーン](./images/角色场景.png)
![シーン](./images/场景.png)

### Phase 03: 監督ワークベンチ
![監督ワークベンチ](./images/导演工作台.png)
![九分割ストーリーボード](./images/镜头九宫格.png)
![ショットとフレーム](./images/镜头与帧.png)
![ショットとフレーム詳細](./images/镜头与帧1.png)

### Phase 04: エクスポート
![エクスポート](./images/成片导出.png)

### プロンプト管理
![プロンプト管理](./images/提示词管理.png)

## 核となる概念：キーフレーム駆動 (Keyframe-Driven)

従来の Text-to-Video モデルでは、具体的なカメラの動きや開始・終了状態を制御することが困難でした。BigBanana はアニメーション制作における **キーフレーム (Keyframe)** の概念を導入しました：

1.  **静止画先行**: まず、正確な開始フレーム (Start) と終了フレーム (End) を生成します。
2.  **補間生成**: Veo モデルを使用して、2つのフレーム間に滑らかな動画トランジションを生成します。
3.  **アセット制約**: すべての画面生成は「キャラクター設定画」と「シーンコンセプト画」によって厳密に制約され、キャラクターの崩壊を防ぎます。

## 主な機能

### Phase 01: 脚本とストーリーボード (Script & Storyboard)
*   **インテリジェントな分解**: 小説やあらすじを入力すると、AI が自動的に標準的な脚本構造（シーン、時間、雰囲気）に分解します。
*   **視覚的翻訳**: テキスト記述をプロ仕様の画像生成プロンプトに自動変換します。
*   **ペーシング制御**: 目標時間（例：30秒の予告編、3分の短編）を設定すると、AI がショット密度を自動調整します。
*   **✨ 手動編集 (NEW)**:
    *   キャラクターの視覚的な説明とショットプロンプトを編集
    *   各ショットのキャラクターリストを編集（キャラクターの追加/削除）
    *   各ショットのアクション説明とセリフを編集
    *   生成結果が期待通りになるよう、すべての詳細を精密に制御

### Phase 02: アセットとキャスティング (Assets & Casting)
*   **一貫性のあるキャラクター**:
    *   各キャラクターの標準参照画像 (Reference Image) を生成します。
    *   **ワードローブシステム (Wardrobe System)**：ベースの顔立ちを維持したまま、複数の衣装（日常着、戦闘服、負傷状態など）を管理できます。
*   **美術設定 (Set Design)**：環境参照画像を生成し、同一シーン内の異なるショットでも照明や背景の統一性を保ちます。

### Phase 03: 監督ワークベンチ (Director Workbench)
*   **グリッド絵コンテ**: すべてのショットをパノラマビューで管理します。
*   **精密制御**:
    *   **Start Frame**: ショットの開始画面（強い一貫性）。
    *   **End Frame**: (オプション) ショット終了時の状態（例：振り返る、照明の変化）を定義します。
*   **九分割ストーリーボードプレビュー (NEW)**:
    *   1つのショットを9視点に分解し、説明を確認・編集してから3x3画像を生成できます。
    *   九分割の全体画像を開始フレームとして使うか、任意のパネルを切り出して開始フレームに使えます。
*   **コンテキスト認識**: AI がショットを生成する際、コンテキスト（現在のシーン画像 + キャラクターの特定の衣装画像）を自動的に読み込み、「シーンの不連続性」を完全に解決します。
*   **動画生成の2モード**: 単一画像の Image-to-Video と、開始/終了フレーム補間 (Keyframe Interpolation) の両方に対応します。

### Phase 04: エクスポート (Export)
*   **タイムラインプレビュー**: 生成されたモーションコミックのセグメントをタイムライン形式でプレビューします。
*   **レンダリング追跡**: API レンダリングの進行状況をリアルタイムで監視します。
*   **アセット出力**: Premiere や After Effects での編集用に、すべての高解像度キーフレームと MP4 クリップを一括エクスポートできます。

## 技術スタック

*   **Frontend**: React 19, Tailwind CSS (Sony Industrial Design Style)
*   **AI Models**:
    *   **Logic/Text**: `GPT-5.2` (脚本分析)
    *   **Vision**: `gemini-3-pro-image-preview` (高速描画)
    *   **Video**: `veo_3_1_i2v_s_fast_fl_landscape` / `sora-2`
    *   **Video**: `veo-3.1-fast-generate-preview` (動画補間)
*   **Storage**: IndexedDB (ブラウザローカルデータベース、プライバシー重視、バックエンド不要)

## プロジェクトの起動

### 方法 1：ローカル開発

```bash
# 1. リポジトリをクローン
git clone https://github.com/shuyu-labs/BigBanana-AI-Director.git
cd BigBanana-AI-Director

# 2. 依存関係をインストール
npm install

# 3. 開発サーバーを起動
npm run dev

# 4. ブラウザでアクセス
# http://localhost:13000 を開く
```

### 方法 2：Docker デプロイ（推奨）

```bash
# 1. リポジトリをクローン
git clone https://github.com/shuyu-labs/BigBanana-AI-Director.git
cd BigBanana-AI-Director

# 2. Docker Compose でビルドして起動
docker-compose up -d --build

# 3. ブラウザでアクセス
# http://localhost:13000 を開く

# ログを確認
docker-compose logs -f

# コンテナを停止
docker-compose down
```

### 方法 3：Docker コマンドを使用

```bash
# 1. リポジトリをクローン
git clone https://github.com/shuyu-labs/BigBanana-AI-Director.git
cd BigBanana-AI-Director

# 2. イメージをビルド
docker build -t bigbanana-ai .

# 3. コンテナを起動
docker run -d -p 13000:80 --name bigbanana-ai-app bigbanana-ai

# 4. ブラウザでアクセス
# http://localhost:13000 を開く

# ログを確認
docker logs -f bigbanana-ai-app

# コンテナを停止
docker stop bigbanana-ai-app
```

### その他のコマンド

```bash
# 本番用ビルド
npm run build

# 本番ビルドのプレビュー
npm run preview

# キャッシュなしで Docker イメージを強制再ビルド
docker-compose build --no-cache
docker-compose up -d --force-recreate
```

---

## クイックスタート

1.  **キーの設定**: アプリを起動し、モデル設定で API Key を入力します。
2.  **ストーリー入力**: Phase 01 でストーリーのアイデアを入力し、「脚本生成」をクリックします。
3.  **美術設定**: Phase 02 に進み、キャラクターシートとシーンコンセプトを生成します。
4.  **ショット制作**: Phase 03 でまず開始フレームを生成し、必要に応じて終了フレームを追加、または九分割プレビューで開始フレーム構図を選択します。
5.  **動画生成**: モデルを選択してクリップを生成します。開始フレームのみでも生成可能で、開始+終了フレームではより安定した遷移を得られます。

---

## プロジェクトの起源

本プロジェクトは [CineGen-AI](https://github.com/Will-Water/CineGen-AI) をベースに二次開発を行い、機能強化と最適化を実施しました。

原作者のオープンソース貢献に感謝します！

---

## ライセンス

本プロジェクトは [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) ライセンスの下で提供されています。

- ✅ 個人学習および非商用利用が許可されています
- ✅ 同じライセンスの下での改変と二次的著作物が許可されています
- ❌ 商用利用は禁止されています

---
*Built for creators.*
