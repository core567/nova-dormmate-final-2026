Page({
  // 1. 定义初始数据
  data: {
    temperature: '',
    humidity: '',
    status: '等待分析',
    advice: '-'
  },

  // 2. 绑定输入框
  onTempInput(e) {
    this.setData({ temperature: e.detail.value });
  },
  onHumidInput(e) {
    this.setData({ humidity: e.detail.value });
  },

  // 3. 点击按钮触发判断（完全照搬你网页端 M1 的逻辑）
  analyzeEnvironment() {
    let tempVal = this.data.temperature;
    let humidVal = this.data.humidity;

    // 空值校验
    if (tempVal === '' || humidVal === '') {
      wx.showToast({ title: '不能为空', icon: 'none' });
      return;
    }
    
    let temp = Number(tempVal);
    let humid = Number(humidVal);
    
    // 非数字校验
    if (isNaN(temp) || isNaN(humid)) {
      wx.showToast({ title: '请输入数字', icon: 'none' });
      return;
    }

    // 统一规则判断
    let status = '正常';
    let advice = '环境舒适';
    if (temp < 18) {
      status = '偏冷'; advice = '建议开启暖气';
    } else if (temp >= 30) {
      status = '偏热'; advice = '建议开启空调';
    } else if (humid >= 75) {
      status = '偏湿'; advice = '建议开启除湿机';
    }

    // 4. 更新数据驱动视图
    this.setData({
      status: status,
      advice: advice
    });
  }
})