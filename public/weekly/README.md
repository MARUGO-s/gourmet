# 週報 HTML（GitHub Pages）

M-talk カードの **「週報を開く」** が指す週報本体です。承認済みの共通テンプレート（`scripts/shared/weekly-report.js`）で生成し、このディレクトリに置きます。

- URL: `https://marugo-s.github.io/gourmet/weekly/<店舗UUID>/<asOf>/`
- 中身: `index.html`（ハブ）＋ `<site>.html`（食べログ・一休など）
- 生成: `node scripts/weekly-deliver.mjs … --store-id <UUID> --publish-dir public --no-post`
- main へマージすると Pages が配置します（`deploy-github-pages.yml`）。M-talk `/store-post` の許可ホストに `marugo-s.github.io` が含まれます。

お客様の氏名・連絡先・口コミ本文は載せません。
