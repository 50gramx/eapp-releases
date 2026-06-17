# eapp-releases

Public release channel for Eutopia/EVO products.

This repo is intentionally public and artifact-focused. Private source, signing
secrets, contract authoring, and product-specific build logic stay in private
repos. The static catalog in this repo is generated from:

- `eapp-interaction-contracts` brand/product metadata
- release metadata JSON published with each build

## Generate Catalog

From this repo:

```powershell
node tools/generate-catalog.mjs `
  --contracts-root ..\eapp-interaction-contracts `
  --metadata-root data\releases `
  --github-releases-repo 50gramx/eapp-releases `
  --output data\catalog.json
```

The site is plain static HTML/CSS/JS and can be hosted through GitHub Pages.
