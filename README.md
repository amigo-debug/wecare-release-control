# WeCare 發佈控制台

[開啟發佈入口](https://github.com/amigo-debug/wecare-release-control/actions/workflows/release.yml)

只控制 WeCare 官網與 ERP 的現有、已核准 production build。這個庫不存放應用程式原始碼、客戶資料、環境檔或原始憑證；不建立新部署、不重新建置、不執行資料庫 migration。

## 操作

1. 登入獲邀的 GitHub 帳戶，開啟上方入口，按 **Run workflow**，保持分支為 `main`。
2. `project` 選 `website`（官網）或 `erp`（ERP）。
3. `operation` 選 `check`（只檢查）、`publish`（發佈）或 `rollback`（回退）。
4. `version` 輸入下方版本表的代號。只檢查時不勾確認；更改正式版本時必須自行勾選確認，再按 Run workflow。
5. 查看該次 Summary。`checked` 只代表只讀檢查完成；`verified` 代表正式域名映射已讀回；`already-current` 代表沒有改動。

發佈成功不等於業務功能已驗收：完成後仍須核對正式網站，ERP 須使用正常登入及獲准資料測試。遇到 `uncertain`／`unverified`，先核對正式域名及 Vercel 記錄，不要重複按發佈。

## 版本表

| 專案 | 代號 | 用途 |
| --- | --- | --- |
| 官網 | `baseline-20261111` | 2026-11-11 觀察到的現有正式版本，只可 check |
| ERP | `baseline-20261111` | 2026-11-11 觀察到的現有正式版本，只可 check |

目前沒有新版本獲准發佈或回退。不能將既有正式網站仍可開啟，當作完整測試通過。

工程維護者完成應用、資料庫相容性、定時工作／外部通知檢查後，透過受保護的 `main` 更新 `releases.json` 和此表。新記錄須綁定不可變 deployment ID 及完整來源 SHA，並在部署 metadata 的 `wecareSourceSha`／`githubCommitSha` 或 `gitSource.sha` 保留相同 SHA。不要重新指向其他專案。

## 帳戶及權限

- 協作者只有這個控制庫的 Write；不需要兩個私人原始碼庫或 Vercel 團隊成員權限，也不授予帳單權限。
- `main` 由分支保護及 CODEOWNERS 保護；操作人不能自行改寫正式發佈指令。原擁有人的管理及維護權限保留。
- `wecare-website`、`wecare-erp` environments 分開保存憑證，各自只允許名為 `main` 的 branch，不允許 tag 或其他 branch。
- 不設定每次發佈必須由另一人批准；操作者在手動表單自行確認。更改控制程式仍需擁有人審閱。
- 只用標準 Ubuntu runner，不上傳 artifact、不使用大型付費 runner；Vercel 原有運行／流量用量仍按原方案計算。

## 憑證設定與驗收

必須由擁有人在 Vercel Account Tokens 建立兩枚獨立、單專案且有到期日的 token，直接加入各自 environment 的 `VERCEL_TOKEN` secret。不要選 Full Account 或 All Projects，不把值貼入對話、程式碼或 log。

每個 environment 設定：

| 欄位 | 初始值／作用 |
| --- | --- |
| `VERCEL_TOKEN`（Secret） | 對應一個 Vercel 專案，不提供給 PR checks |
| `RELEASE_ACTORS`（Variable） | 經確認的 GitHub 用戶名稱，以逗號分隔；不是 email |
| `RELEASE_ENABLED`（Variable） | 初始 `false`，只讀 scope 驗證通過後才啟用 |

每次操作先要求 token 只列出本專案，且讀取另一個 WeCare 專案必須被拒；配置過寬會停止。這些只讀測試不代表 provider 寫入權限或實際發佈已驗證。

Token 到期時更換同範圍 token 並重做兩個 check；憑證失效應停下而不是改用範圍更大的 token。

## 開發驗證

```text
node --check scripts/release.mjs
node --test test/*.test.mjs
```

測試使用虛構資料，不連正式 API；綠燈不是 Derek 已接受邀請、secret 已配置或正式發佈演練完成的證據。
