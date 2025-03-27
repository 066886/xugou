import { Hono } from 'hono';
import { Bindings } from '../models/db';
import { Monitor } from '../models/monitor';
import { generateToken } from '../utils/jwt';

const monitorTask = new Hono<{ Bindings: Bindings }>();

// 清理30天以前的历史记录
async function cleanupOldRecords(c: any) {
  try {
    console.log('开始清理30天以前的历史记录...');
    
    // 清理监控状态历史记录
    const deleteStatusHistoryResult = await c.env.DB.prepare(`
      DELETE FROM monitor_status_history 
      WHERE timestamp < datetime('now', '-30 days')
    `).run();
    
    // 清理监控检查记录
    const deleteChecksResult = await c.env.DB.prepare(`
      DELETE FROM monitor_checks 
      WHERE checked_at < datetime('now', '-30 days')
    `).run();
    
    console.log(`清理完成：删除了 ${deleteStatusHistoryResult.meta?.changes || 0} 条状态历史记录，${deleteChecksResult.meta?.changes || 0} 条检查记录`);
    
    return {
      success: true,
      statusHistoryDeleted: deleteStatusHistoryResult.meta?.changes || 0,
      checksDeleted: deleteChecksResult.meta?.changes || 0
    };
  } catch (error) {
    console.error('清理历史记录出错:', error);
    return { success: false, error: String(error) };
  }
}

// 监控检查的主要函数
async function checkMonitors(c: any) {
  try {
    console.log('开始执行监控检查...');
    
    // 清理30天以前的历史记录
    await cleanupOldRecords(c);
    
    // 获取当前时间
    const now = new Date();
    
    // 查询需要检查的监控
    // 条件：active=true 且 (last_checked 为 null 或 当前时间 - last_checked > interval)
    const monitors = await c.env.DB.prepare(`
      SELECT * FROM monitors 
      WHERE active = true 
      AND (last_checked IS NULL OR datetime('now') > datetime(last_checked, '+' || interval || ' seconds'))
    `).all();
    
    console.log(`找到 ${monitors?.results?.length || 0} 个需要检查的监控`);
    
    if (!monitors.results || monitors.results.length === 0) {
      return { success: true, message: '没有需要检查的监控', checked: 0 };
    }
    
    // 检查每个监控
    const results = await Promise.all(monitors.results.map(async (monitor: Monitor) => {
      return await checkSingleMonitor(c, monitor);
    }));
    
    return { 
      success: true, 
      message: '监控检查完成', 
      checked: results.length,
      results: results
    };
  } catch (error) {
    console.error('监控检查出错:', error);
    return { success: false, message: '监控检查出错', error: String(error) };
  }
}

// 检查单个监控的函数
async function checkSingleMonitor(c: any, monitor: Monitor) {
  try {
    console.log(`开始检查监控项: ${monitor.name} (${monitor.url})`);
    
    const startTime = Date.now();
    
    // 解析 headers
    const customHeaders = monitor.headers ? JSON.parse(monitor.headers) : {};
    
    // 执行请求
    const response = await fetch(monitor.url, {
      method: monitor.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Google Chrome";v="123", "Not:A-Brand";v="8"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Referer': new URL(monitor.url).origin,
        ...customHeaders
      },
      body: monitor.body || undefined
    });
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    // 检查响应状态
    let isUp = false;
    
    // 支持状态码范围检查
    if (monitor.expected_status === 200) {
      // 如果是精确的状态码，就精确匹配
      isUp = response.status === monitor.expected_status;
    } else if (monitor.expected_status === 2) {
      // 如果是2，则表示2xx
      isUp = response.status >= 200 && response.status < 300;
    } else if (monitor.expected_status === 3) {
      // 如果是3，则表示3xx
      isUp = response.status >= 300 && response.status < 400;
    } else if (monitor.expected_status === 4) {
      // 如果是4，则表示4xx
      isUp = response.status >= 400 && response.status < 500;
    } else if (monitor.expected_status === 5) {
      // 如果是5，则表示5xx
      isUp = response.status >= 500 && response.status < 600;
    } else {
      // 其他情况，精确匹配
      isUp = response.status === monitor.expected_status;
    }
    
    const status = isUp ? 'up' : 'down';
    
    // 记录状态历史
    await c.env.DB.prepare(
      `INSERT INTO monitor_status_history (monitor_id, status, timestamp) 
       VALUES (?, ?, datetime('now'))`
    ).bind(monitor.id, status).run();
    
    // 记录检查详情
    await c.env.DB.prepare(
      `INSERT INTO monitor_checks (monitor_id, status, response_time, status_code, checked_at) 
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(monitor.id, status, responseTime, response.status).run();
    
    // 更新监控项状态
    await c.env.DB.prepare(
      `UPDATE monitors 
       SET status = ?, 
           last_checked = datetime('now'),
           response_time = ?,
           uptime = (
             SELECT ROUND((COUNT(CASE WHEN status = 'up' THEN 1 ELSE NULL END) * 100.0 / COUNT(*)), 2)
             FROM monitor_status_history
             WHERE monitor_id = ?
             ORDER BY timestamp DESC
             LIMIT 100
           )
       WHERE id = ?`
    ).bind(status, responseTime, monitor.id, monitor.id).run();
    
    console.log(`监控项检查完成: ${monitor.name}, 状态: ${status}, 响应时间: ${responseTime}ms`);
    
    return {
      success: true,
      status,
      responseTime
    };
  } catch (error: any) {
    console.error(`检查监控项失败: ${monitor.name}`, error);
    
    // 记录错误状态
    await c.env.DB.prepare(
      `INSERT INTO monitor_status_history (monitor_id, status, timestamp) 
       VALUES (?, ?, datetime('now'))`
    ).bind(monitor.id, 'down').run();
    
    // 记录检查详情
    await c.env.DB.prepare(
      `INSERT INTO monitor_checks (monitor_id, status, response_time, status_code, error, checked_at) 
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(monitor.id, 'down', 0, 0, error.message).run();
    
    // 更新监控项状态
    await c.env.DB.prepare(
      `UPDATE monitors 
       SET status = 'down', 
           last_checked = datetime('now'),
           response_time = 0,
           uptime = (
             SELECT ROUND((COUNT(CASE WHEN status = 'up' THEN 1 ELSE NULL END) * 100.0 / COUNT(*)), 2)
             FROM monitor_status_history
             WHERE monitor_id = ?
             ORDER BY timestamp DESC
             LIMIT 100
           )
       WHERE id = ?`
    ).bind(monitor.id, monitor.id).run();
    
    return {
      success: false,
      status: 'down',
      error: error.message
    };
  }
}

// 定义触发器路由 - 通过HTTP请求触发监控检查
monitorTask.get('/api/trigger-check', async (c) => {
  const result = await checkMonitors(c);
  return c.json(result);
});

// 在 Cloudflare Workers 中设置定时触发器
export default {
  async scheduled(event: any, env: any, ctx: any) {
    const c = { env };
    await checkMonitors(c);
  },
  fetch: monitorTask.fetch
}; 