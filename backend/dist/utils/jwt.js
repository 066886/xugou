"use strict";
/**
 * JWT工具类，提供JWT相关的通用功能
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJwtSecret = void 0;
exports.generateToken = generateToken;
/**
 * 获取JWT密钥
 * 优先从环境变量中获取JWT_SECRET，如果不存在则使用默认值
 *
 * @param c Cloudflare环境上下文
 * @returns JWT密钥
 */
const getJwtSecret = (c) => {
    // 在Cloudflare Workers环境中，使用env变量
    if (typeof process === 'undefined') {
        return c.env.JWT_SECRET || 'your-secret-key-change-in-production';
    }
    // 在Node.js环境中，使用process.env
    return process.env.JWT_SECRET || 'your-secret-key-change-in-production';
};
exports.getJwtSecret = getJwtSecret;
/**
 * 生成随机令牌
 * 生成用于API密钥或认证令牌的随机字符串
 *
 * @returns 生成的随机令牌
 */
async function generateToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
//# sourceMappingURL=jwt.js.map