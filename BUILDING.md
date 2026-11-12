# 回联盟 iOS 工程

这是一个原生 UIKit + WKWebView 工程，运行“回联盟”的本地网页资源。它不包含卡密、激活或原程序服务端。

## 构建未签名 IPA

### GitHub Actions

1. 解压 `huilianmeng-ios-source.zip`。
2. 将全部内容上传到一个新的 GitHub 私有仓库。
3. 打开仓库的 **Actions** 页面。
4. 选择 **Build unsigned IPA**，点击 **Run workflow**。
5. 构建完成后下载 `HuiLianMeng-unsigned-ipa`。
6. 使用你有权使用的 Apple 证书和轻松签对 `HuiLianMeng-unsigned.ipa` 签名。

### 有 macOS 和 Xcode

```bash
brew install xcodegen
xcodegen generate
open HuiLianMeng.xcodeproj
```

在 Xcode 中选择自己的 Team 和有效签名配置，然后通过真机运行或 Archive。

## 说明

- GitHub Actions 生成的是未签名 IPA。
- 不提供或伪造 Apple 开发者证书。
- 请只使用自己持有且允许使用的签名证书。
- WKWebView 允许加载用户主动输入的远程 HTTP/HTTPS ZIP 地址；敏感数据建议始终使用 HTTPS。
- 远程 ZIP 仍要求目标服务器支持 CORS 和 HTTP Range。
