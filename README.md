把[edgetunnel](https://github.com/zizifn/edgetunnel)改造成普通nodejs项目，实现vless协议，代码参考了https://github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js

原项目只能部署在cloudflare的worker，准备改成普通node项目部署在别处

目前http可以了，https不行，发现https情况下是一次on connection内收到多次on message，需要合并

使用：

npm install

npm start
