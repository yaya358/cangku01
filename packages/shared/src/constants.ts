/** 应用显示名，出现在 title、健康检查与日志中。 */
export const APP_NAME = '酒馆 AI';

/** 语义化版本号，与 package.json 保持同步。 */
export const APP_VERSION = '0.1.0';

/** 所有 HTTP 接口统一挂在 /api 前缀下，方便前端走 Vite 代理。 */
export const API_PREFIX = '/api';

/** 后端默认端口；可在 config/*.yaml 或环境变量中覆盖。 */
export const DEFAULT_SERVER_PORT = 8787;

/** 前端开发服务器默认端口。 */
export const DEFAULT_WEB_PORT = 5173;

/** 健康检查接口路径。 */
export const HEALTH_ENDPOINT = `${API_PREFIX}/health`;
