var IncomingWebhook = require('@slack/webhook').IncomingWebhook

module.exports = function slack (config) {
  var slack = {
    pushMessage: function(title, message) {
      var slackWebhook = new IncomingWebhook(config.webhook_url || '')
      slackWebhook.send(title + ': ' + message).catch(function (err) {
        console.error('\nerror: slack webhook')
        console.error(err)
      })
    }
  }
  return slack
}
