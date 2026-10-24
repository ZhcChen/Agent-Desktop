# Agent Desktop 运行时镜像
#
# 里面只有两样东西：Node 运行时 + pi。
# agent 的一切动作（读写文件、执行命令）都发生在这个容器里，
# 宿主只负责起停与挂载。
FROM node:22-slim

# git：agent 常见工作流需要；ripgrep：pi 的文件搜索工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-desktop

# pi 装在运行时旁边，Node 靠目录向上查找解析它。
RUN npm init -y >/dev/null 2>&1 \
  && npm install --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0

# 运行时脚本由构建产物拷入。
COPY out/runtime/ /opt/agent-desktop/runtime/

ENV NODE_PATH=/opt/agent-desktop/node_modules \
    AGENT_DESKTOP_AGENT_DIR=/etc/agent-desktop/pi

# tini 作为 PID 1，保证容器内孤儿进程能被回收。
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agent-desktop/runtime/agent-runtime.mjs"]
