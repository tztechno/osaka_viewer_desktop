# Osaka 3D Viewer Desktop

大阪の3D都市モデル（PLATEAU）および国土地理院の標高・写真データを活用した3D地図ビューアのデスクトップアプリケーション（Tauri v2 + Cesium + Vite）。

## 特徴
- **PLATEAU 3D都市モデル**: 大阪の建物モデルを高速表示
- **標高・地形データ**: リアルタイム3D地形レンダリング
- **ランドマーク・駅・施設表示**: 地名・スポットの検索と表示
- **日照・シェーディング**: 太陽光シミュレーションによるリアルな陰影
- **多言語対応**: 日本語 / English 切り替え

## 開発・ビルド

### 依存関係のインストール
```bash
npm install
```

### 開発モード（Hot Reload）
```bash
npm run dev
# または Tauri 開発環境
npm run tauri dev
```

### デスクトップアプリのビルド
```bash
npm run tauri build
```
ビルド成果物は `src-tauri/target/release/bundle/` に出力されます。
- macOS: `.dmg` / `.app`
- Windows: `.exe` (NSIS) / `.msi`
