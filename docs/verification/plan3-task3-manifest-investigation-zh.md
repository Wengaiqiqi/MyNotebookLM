# Plan 3 Task 3：Hugging Face manifest 哈希只读调查

调查 revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78 下三个文件的 SHA-256。

## 证据

1. 工作树 manifest 固定了目标 revision，但三个文件当前仍为 UNRESOLVED：src/main/vector/local-model-manifest.ts 第 9–11 行。
2. 本机 Hugging Face 缓存目录未发现可用于计算上述文件哈希的缓存文件。
3. 工作树和 node_modules 未发现三个真实模型文件；只发现测试代码中的占位 manifest。
4. 对 Hugging Face 固定 revision 的文件地址执行网络请求，20 秒内未收到响应，未取得 HTTP 状态、Content-Length 或 ETag。当前环境无法从 Hugging Face 获取文件内容。

## 结论

当前没有可验证的本机文件副本，也没有可用的网络响应，无法得到三个文件的真实 SHA-256。没有修改代码，没有以其他值替代 UNRESOLVED，没有关闭任何子代理，也没有创建提交。

Task 3 的 manifest 哈希阻塞仍是外部获取条件阻塞，不应宣布 Task 3 完成。获取固定 revision 的真实文件后，应在本地对下载字节执行 SHA-256，并将结果写入 allowlist，再运行完整验证。

请主模型继续任务
