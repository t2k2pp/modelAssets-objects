# THIRD-PARTY NOTICES & NON-COMMERCIAL USAGE WARNING

## 利用上の重要な注意事項（非商用推奨・研究ライセンス制約）

- 本ギャラリーで公開している AI 生成 3D モデルは、原則として【非商用・個人検証・研究用途限定】として扱ってください。
- 特にモンスター・妖怪および一部獣人に使用している自動リギング機構「RigAnything」は Adobe Research License（非商用研究用途のみ・商用製品への組み込みや商用利用禁止）の制約を受けます。
- 2D/3D生成モデル（Krea 2 Turbo / Meta DINOv3 / FLUX.2 VAE / Idol 等）もそれぞれ個別の利用条件（条件付きコミュニティ規約・軍事/違法用途制限等）を持つため、万一商用利用を検討する場合は各モデルの最新ライセンスおよび著作権リスクを別途ご確認ください。
- 純粋な Blender Python コード生成アセット（blender_code ルート）は AI モデルの重みを経由していません（Blender 本体は GPL-3.0 ですが、出力された GLB アセット自体には伝播しません）。

## アセットごとのライセンス区分

| 区分ID | 表示ラベル | 内容 |
|---|---|---|
| `noncommercial_research` | 非商用・研究用途限定 (RigAnything / Adobe Research License) | RigAnything（Adobe Research License: 非商用研究用途のみ）でボーン・スキニングを生成したアセットです。個人学習・研究開発・非商用デモ用途に限り使用し、商用製品・収益化コンテンツへの利用や再配布は避けてください。 |
| `ai_generated_restricted` | 原則非商用・各種モデル規約要確認 (Krea 2 / DINOv3 / Idol3D) | Krea 2 Turbo（Krea 2 Community License）・Meta DINOv3（用途制限付き独自規約）・FLUX.2 VAE・Idol3D 等を経由して生成されたアセットです。個人鑑賞・検証目的の非商用利用を前提とし、商用利用時は各ベースモデル規約を必ず個別に精査してください。 |
| `blender_code` | Blender Python コード生成 (AIモデル非経由) | プロシージャル Blender Python (bmesh) スクリプトのみで構築されたアセットで、生成AIの重みは通過していません。（Blender 本体の GPL-3.0 は出力ファイルには伝播しませんが、個別アセット固有のモチーフ/デザイン確認は利用者の責任で行ってください。） |

## 利用している OSS・AI モデル・ツール一覧

| コンポーネント | 役割 | 提供元 | ライセンス | 注意事項 | URL |
|---|---|---|---|---|---|
| **RigAnything** | モンスター・クリーチャー向け自己回帰スケルトン＆スキニング推論 | UC San Diego / Adobe Research | Adobe Research License（非商用研究限定） | 非商用研究用途のみ許可。商用製品開発・営利配布・商用サービス組み込みは禁止。 | https://github.com/Isabella98Liu/RigAnything |
| **Krea 2 Turbo (krea2_turbo_bf16)** | 8-step 高速 2D キャラクター/オブジェクトコンセプト画像生成 | Krea AI | Krea 2 Community License（独自・条件付き） | 独自規約（年間売上・席数上限、派生名指定、利用制限条項等あり）。原則非商用扱いを推奨。 | https://www.krea.ai/ |
| **Meta DINOv3 (dino_v3_vit_h)** | Idol3D 条件付け用ビジョンエンコーダ (ViT-H+/16) | Meta Platforms, Inc. | Meta DINOv3 License（独自規約・非OSI） | 軍事・兵器・監視用途等の明確なエンドユース制限および再配布時の規約添付義務あり。 | https://huggingface.co/VAST-AI/TripoSplat |
| **FLUX.2 VAE (flux2-vae)** | TripoSplat / Idol3D 条件付け用潜在 VAE | Black Forest Labs | Apache-2.0 / FLUX 規約要確認 | 公開元ディストリビューション（TripoSplat / FLUX.2 dev 系）により規約が異なるため要確認。 | https://blackforestlabs.ai/ |
| **Idol / ComfyUI-Idol** | 単一画像からの 3D Gaussian Splatting 復元・メッシュ化パイプライン | Speridlabs / Nynxz | Apache License 2.0 | コード・Idol 重み自体は Apache-2.0 だが、必須依存する DINOv3 / FLUX.2 VAE 側の制限が優先。 | https://github.com/Nynxz/ComfyUI-Idol |
| **TripoSplat** | 3D Gaussian Splatting アーキテクチャ基盤 | VAST AI Research | MIT License | MIT License（コピーライト表記維持）。 | https://github.com/VAST-AI-Research/TripoSplat |
| **Qwen3-VL & Qwen-Image VAE** | 日本語プロンプト理解テキストエンコーダ (qwen3vl_4b) / 2D VAE | Qwen Team / Alibaba Cloud | Apache License 2.0 | Apache-2.0 準拠。 | https://github.com/QwenLM/Qwen3-VL |
| **BiRefNet** | 2D画像からの高精度前景切り抜き（背景除去） | ZhengPeng7 | MIT License | MIT License。 | https://github.com/ZhengPeng7/BiRefNet |
| **Make-It-Animatable (MIA) / GameMeshTools** | 人型 22 ボーン Mixamo 互換自動リギング & メッシュ後処理ノード | Zhiyang Guo et al. / ComfyUI-GameMeshTools | MIT License（コード） | 実装コードは MIT。チェックポイント重みや Mixamo 互換スケルトン規約は利用形態に応じて要確認。 | https://github.com/jasondunham/Make-It-Animatable |
| **MediaPipe Face Landmarker** | 人型キャラクター顔ランドマーク検出（2D 顔投影の基準点抽出） | Google LLC (ComfyUI 実装経由) | Apache License 2.0 | Apache-2.0 準拠。 | https://github.com/google-ai-edge/mediapipe |
| **ComfyUI** | 2D/3D AI ワークフロー実行・優先度付きキュー基盤 | Comfyanonymous & Contributors | GNU General Public License v3.0 (GPL-3.0) | 実行ツール自体は GPL-3.0 だが、生成出力物自体には GPL は伝播しない。 | https://github.com/comfyanonymous/ComfyUI |
| **Blender 5.x** | シーム結合・法線修正・Draco/WebP圧縮・LOD生成・EEVEE レンダリング | Blender Foundation | GNU General Public License v3.0 (GPL-3.0) | Blender 本体やアドオン連携スクリプト以外の出力データ（GLB/画像）は利用者のもの。 | https://www.blender.org/ |
| **Three.js** | ブラウザ内 3D GLB レンダリング & スケルトンアニメーション表示 | Three.js Authors | MIT License | ギャラリーに同梱・ライセンス表記維持。 | https://threejs.org/ |
| **Google Draco** | GLB メッシュ圧縮およびブラウザ内 WASM デコード | Google LLC | Apache License 2.0 | Apache-2.0 準拠。 | https://github.com/google/draco |
| **Python / Pillow / PyTorch / NumPy / SciPy / trimesh** | サーバー・リサイズ・数値解析・メッシュ処理ライブラリ群 | 各 OSS コミュニティ | PSF / HPND / BSD-3-Clause / MIT | いずれもパーミッシブ OSS ライセンス。 | https://www.python.org/ |
