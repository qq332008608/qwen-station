'use strict';
// 对应 OpenClaw 内置项: skill / weather
// 保留: 查询城市当前天气和未来三天预报 (使用 wttr.in 公开接口, 无需密钥)
// 舍弃: curl 回退方案, 复杂格式解析, 历史气候数据

const str = d => ({ type: 'string', description: d });

module.exports = {
  name: 'weather',
  tools: [
    {
      name: 'get_weather',
      description: '查询指定城市的当前天气和未来三天预报。输入城市名（如 "Beijing"）或坐标。',
      parameters: {
        type: 'object',
        properties: {
          location: str('城市名称、地区、机场代码或经纬度，例如 "London" 或 "39.9,116.4"')
        },
        required: ['location']
      },
      async run(a, ctx) {
        const loc = String(a.location).trim();
        if (!loc) throw new Error('位置不能为空');

        // 使用 format=j1，包含 weather 数组用于预报
        const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1`;

        let data;
        try {
          data = await ctx.getJSON(url, 20000);
        } catch (e) {
          throw new Error('网络请求失败: ' + e.message);
        }

        if (!data) {
          // 区分超时/无数据与城市错误
          // getJSON 返回 null 通常表示超时或解析失败
          throw new Error('无法获取天气数据（可能超时或城市名无效），请检查网络或尝试其他城市名');
        }

        const current = data.current_condition && data.current_condition[0];
        if (!current) throw new Error('返回数据中缺少当前天气信息');

        // 安全提取字段
        const getVal = (obj, key) => (obj && obj[key] !== undefined ? String(obj[key]) : '未知');
        
        let areaName = loc;
        if (data.nearest_area && data.nearest_area[0] && data.nearest_area[0].areaName && data.nearest_area[0].areaName[0]) {
          areaName = data.nearest_area[0].areaName[0].value;
        } else {
          areaName = `按输入查询: ${loc}`;
        }

        const condition = current.weatherDesc && current.weatherDesc[0] ? current.weatherDesc[0].value : '未知';
        const tempC = getVal(current, 'temp_C');
        const feelsLikeC = getVal(current, 'FeelsLikeC');
        const humidity = getVal(current, 'humidity');
        const precipMM = getVal(current, 'precipMM');
        const windSpeed = getVal(current, 'windspeedKmph');

        let result = `地点: ${areaName}\n`;
        result += `当前: ${condition}, ${tempC}°C (体感 ${feelsLikeC}°C)\n`;
        result += `湿度: ${humidity}%, 降水: ${precipMM}mm, 风速: ${windSpeed}km/h\n`;

        // 提取未来三天预报
        if (data.weather && data.weather.length > 0) {
          result += `\n未来预报:\n`;
          const days = data.weather.slice(0, 3);
          for (const day of days) {
            const date = day.date || '未知日期';
            const maxT = getVal(day, 'maxtempC');
            const minT = getVal(day, 'mintempC');
            
            let desc = '未知';
            if (day.hourly && day.hourly.length > 0) {
              // 找中午12点或最接近的时段
              let targetHour = null;
              for (const h of day.hourly) {
                if (h.time === '1200') {
                  targetHour = h;
                  break;
                }
              }
              if (!targetHour) {
                targetHour = day.hourly[Math.floor(day.hourly.length / 2)];
              }
              if (targetHour && targetHour.weatherDesc && targetHour.weatherDesc[0]) {
                desc = targetHour.weatherDesc[0].value;
              }
            }
            result += `  ${date}: ${desc}, ${minT}°C ~ ${maxT}°C\n`;
          }
        }

        // 先输出预报，再截断，确保三天预报完整可见
        return ctx.clip(result, 2000);
      }
    }
  ]
};
