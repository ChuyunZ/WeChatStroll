Page({
  data: {
    currentPage: 0,

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
        questionText: "上述选择的时间是？",
        options: [
          {
            label: "单程",
            selected: false
          },
          {
            label: "往返回到起始点",
            selected: false
          },
          {
            label: "往返回到任意点",
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
            selected: false
          },
          {
            label: "适中",
            selected: false
          },
          {
            label: "热闹",
            selected: false
          }
        ],
        answer: null
      },

      {
        questionId: "q4",
        questionText: "你喜欢什么散步环境呢？",
        options: [
          {
            label: "公园",
            selected: false
          },
          {
            label: "水边",
            selected: false
          },
          {
            label: "街道",
            selected: false
          },
          {
            label: "商街",
            selected: false
          }
        ],
        answer: []
      }
    ]
  },

  // Q1
  onTimeChange(e) {
    const hourIndex = e.detail.value[0]
    const minuteIndex = e.detail.value[1]

    const hours = this.data.hourOptions[hourIndex]
    const minutes = Number(this.data.minuteOptions[minuteIndex])

    this.setData({
      timePickerValue: [hourIndex, minuteIndex],
      "questions[0].answer": {
        hours: hours,
        minutes: minutes
      }
    })
  },

  // Q2 + Q3
  onSingleSelect(e) {
    const questionIndex = Number(
      e.currentTarget.dataset.questionIndex
    )

    const optionIndex = Number(
      e.currentTarget.dataset.optionIndex
    )

    const questions = this.data.questions
    const options = questions[questionIndex].options

    for (let i = 0; i < options.length; i++) {
      options[i].selected = false
    }

    options[optionIndex].selected = true

    questions[questionIndex].answer =
      options[optionIndex].label

    this.setData({
      questions: questions
    })

    console.log(
      "single answer:",
      questions[questionIndex].answer
    )
  },

  // Q4
  onMultiSelect(e) {
    const questionIndex = Number(
      e.currentTarget.dataset.questionIndex
    )

    const optionIndex = Number(
      e.currentTarget.dataset.optionIndex
    )

    const questions = this.data.questions
    const options = questions[questionIndex].options

    // toggle
    options[optionIndex].selected =
      !options[optionIndex].selected

    const answers = []

    for (let i = 0; i < options.length; i++) {
      if (options[i].selected) {
        answers.push(options[i].label)
      }
    }

    questions[questionIndex].answer = answers

    this.setData({
      questions: questions
    })

    console.log(
      "multi answer:",
      questions[questionIndex].answer
    )
  },

  nextPage() {
    if (this.data.currentPage < 1) {
      this.setData({
        currentPage: this.data.currentPage + 1
      })
    }
  },

  previousPage() {
    if (this.data.currentPage > 0) {
      this.setData({
        currentPage: this.data.currentPage - 1
      })
    }
  },

  goToRoutes() {
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