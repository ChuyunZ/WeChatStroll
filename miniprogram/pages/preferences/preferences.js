Page({
  data: {
    currentPage: 0,

    // Q2 图片预览
    previewVisible: false,
    previewImage: "",
    previewTitle: "",

    hourOptions: [0, 1, 2, 3, 4, 5],

    minuteOptions: [
      "00", "05", "10", "15", "20", "25",
      "30", "35", "40", "45", "50", "55"
    ],

    timePickerValue: [0, 6],

    questions: [
      {
        questionId: "q1",
        questionText: "你对散步时长的偏好是？",
        answer: {
          hours: 0,
          minutes: 30
        }
      },

      {
        questionId: "q2",
        questionText: "你更喜欢哪种散步路线？",
        options: [
          {
            label: "环线",
            value: "loop",
            description: "从起点出发，绕一圈后回到起点",
            image: "/images/route-loop.png",
            selected: false
          },
          {
            label: "往返",
            value: "out_and_back",
            description: "到达一个地点后，再沿大致相同路线返回",
            image: "/images/route-out-and-back.png",
            selected: false
          },
          {
            label: "单程",
            value: "point_to_point",
            description: "从一个地点出发，在另一个地点结束",
            image: "/images/route-point-to-point.png",
            selected: false
          }
        ],
        answer: null
      },

      {
        questionId: "q3",
        questionText: "你对人流的偏好是？",
        options: [
          {
            label: "安静",
            value: "low",
            selected: false
          },
          {
            label: "适中",
            value: "medium",
            selected: false
          },
          {
            label: "热闹",
            value: "high",
            selected: false
          }
        ],
        answer: null
      },

      {
        questionId: "q4",
        questionText: "请按喜好程度选择散步环境",
        options: [
          {
            label: "公园",
            value: "park",
            rank: null
          },
          {
            label: "水边",
            value: "waterside",
            rank: null
          },
          {
            label: "街道",
            value: "street",
            rank: null
          },
          {
            label: "商街",
            value: "shopping_area",
            rank: null
          }
        ],
        answer: []
      }
    ]
  },


  // =========================
  // Q1
  // =========================

  onTimeChange(e) {
    const hourIndex = e.detail.value[0]
    const minuteIndex = e.detail.value[1]

    const hours =
      this.data.hourOptions[hourIndex]

    const minutes =
      Number(
        this.data.minuteOptions[minuteIndex]
      )

    this.setData({
      timePickerValue: [
        hourIndex,
        minuteIndex
      ],

      "questions[0].answer": {
        hours: hours,
        minutes: minutes
      }
    })
  },


  // =========================
  // Q2 + Q3
  // =========================

  onSingleSelect(e) {
    const questionIndex = Number(
      e.currentTarget.dataset.questionIndex
    )

    const optionIndex = Number(
      e.currentTarget.dataset.optionIndex
    )

    const questions =
      this.data.questions

    const options =
      questions[questionIndex].options


    // 清除旧选择
    for (let i = 0; i < options.length; i++) {
      options[i].selected = false
    }


    // 设置新选择
    options[optionIndex].selected = true


    const selectedOption =
      options[optionIndex]

    questions[questionIndex].answer =
      selectedOption.value
        ? selectedOption.value
        : selectedOption.label


    this.setData({
      questions: questions
    })


    // console.log(
    //   "single answer:",
    //   questions[questionIndex].answer
    // )
  },


  // =========================
  // Q2 图片放大
  // =========================

  openRoutePreview(e) {
    const src =
      e.currentTarget.dataset.src

    const title =
      e.currentTarget.dataset.title

    this.setData({
      previewVisible: true,
      previewImage: src,
      previewTitle: title
    })
  },


  closeRoutePreview() {
    this.setData({
      previewVisible: false,
      previewImage: "",
      previewTitle: ""
    })
  },


  // 防止点击图片区域时
  // modal 自己被关闭
  preventClose() {
  },


  // =========================
  // Q4
  // 按点击顺序自动分配 1 / 2 / 3 / 4
  // =========================

  onRankSelect(e) {
    const optionIndex = Number(
      e.currentTarget.dataset.optionIndex
    )

    const questions =
      this.data.questions

    const options =
      questions[3].options

    const clickedOption =
      options[optionIndex]


    // =========================
    // 已经选择过
    // 再点一次 = 取消
    // =========================

    if (clickedOption.rank !== null) {

      const removedRank =
        clickedOption.rank

      clickedOption.rank = null


      // 原本排在它后面的
      // 全部向前补一位
      for (let i = 0; i < options.length; i++) {

        if (
          options[i].rank !== null &&
          options[i].rank > removedRank
        ) {
          options[i].rank -= 1
        }
      }

    }


    // =========================
    // 还没选择
    // 给它下一个 rank
    // =========================

    else {

      let selectedCount = 0

      for (let i = 0; i < options.length; i++) {

        if (options[i].rank !== null) {
          selectedCount += 1
        }
      }


      clickedOption.rank =
        selectedCount + 1
    }


    // =========================
    // 根据 rank 生成最终 answer
    // =========================

    const rankedOptions =
      options
        .filter(
          option => option.rank !== null
        )
        .sort(
          (a, b) => a.rank - b.rank
        )


    questions[3].answer =
      rankedOptions.map(
        option => option.value
      )


    this.setData({
      questions: questions
    })


    // console.log(
    //   "Q4 ranking:",
    //   questions[3].answer
    // )
  },


  // =========================
  // 页面导航
  // =========================

  nextPage() {
    if (this.data.questions[1].answer == null) {
      wx.showModal({
        title: "提示",
        content: "请先选择你喜欢的散步路线",
        showCancel: false
      })

      return;
    }

    if (this.data.currentPage < 1) {
      this.setData({
        currentPage: this.data.currentPage + 1
      })
    }
  },


  previousPage() {
    if (this.data.currentPage > 0) {
      this.setData({
        currentPage:
          this.data.currentPage - 1
      })
    }
  },

  buildNormalizedPreferences() {
    const questions = this.data.questions

    const durationMinutes = questions[0].answer.hours * 60 + questions[0].answer.minutes
    const routeType = questions[1].answer
    const crowdPreference = questions[2].answer
    const environmentPreferences = questions[3].answer

    const currentPreferences = {
      durationMinutes: durationMinutes,
      routeType: routeType,
      crowdPreference: crowdPreference,
      environmentPreferences: environmentPreferences
    }
    
    return currentPreferences
  },


  goToRoutes() {
    if (this.data.questions[2].answer  == null) {
      wx.showModal({
        title: "提示",
        content: "请先选择人流偏好",
        showCancel: false
      })

      return;
    }

    if (this.data.questions[3].answer.length != 4) {
      wx.showModal({
        title: "提示",
        content: "请先对散步环境排序",
        showCancel: false
      })

      return;
    }

    // console.log(
    //   "final answers:",
    //   this.data.questions.map(
    //     question => ({
    //       questionId:
    //         question.questionId,

    //       answer:
    //         question.answer
    //     })
    //   )
    // )

    const currentPreferences = this.buildNormalizedPreferences()

    const app = getApp()
    app.globalData.currentPreferences = currentPreferences

    console.log(
      "stored preferences:",
      app.globalData.currentPreferences
    )

    wx.navigateTo({
      url: "/pages/routes/routes"
    })
  },


  goToProfile() {
    wx.navigateTo({
      url: "/pages/profile/profile"
    })
  }

})