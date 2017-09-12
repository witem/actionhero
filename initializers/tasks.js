'use strict'

const NodeResque = require('node-resque')

module.exports = {
  startPriority: 900,
  loadPriority: 699,
  initialize: function (api) {
    api.tasks = {

      tasks: {},
      jobs: {},
      middleware: {},
      globalMiddleware: [],

      loadFile: function (fullFilePath, reload) {
        if (!reload) { reload = false }

        api.watchFileAndAct(fullFilePath, () => {
          api.tasks.loadFile(fullFilePath, true)
        })

        let task
        try {
          const collection = require(fullFilePath)
          for (let i in collection) {
            task = collection[i]
            api.tasks.tasks[task.name] = task
            api.tasks.validateTask(api.tasks.tasks[task.name])
            api.tasks.jobs[task.name] = api.tasks.jobWrapper(task.name)
            api.log(`task ${(reload ? '(re)' : '')} loaded: ${task.name}, ${fullFilePath}`, 'debug')
          }
        } catch (error) {
          api.exceptionHandlers.loader(fullFilePath, error)
          delete api.tasks.tasks[task.name]
          delete api.tasks.jobs[task.name]
        }
      },

      jobWrapper: function (taskName) {
        const task = api.tasks.tasks[taskName]

        let middleware = task.middleware || []
        let plugins = task.plugins || []
        let pluginOptions = task.pluginOptions || []

        if (task.frequency > 0) {
          if (plugins.indexOf('JobLock') < 0) { plugins.push('JobLock') }
          if (plugins.indexOf('QueueLock') < 0) { plugins.push('QueueLock') }
          if (plugins.indexOf('DelayQueueLock') < 0) { plugins.push('DelayQueueLock') }
        }

        // load middleware into plugins
        const processMiddleware = (m) => {
          if (api.tasks.middleware[m]) {
            class Plugin extends NodeResque.Plugin {}
            if (api.tasks.middleware[m].preProcessor) { Plugin.beforePerform = api.tasks.middleware[m].preProcessor }
            if (api.tasks.middleware[m].postProcessor) { Plugin.afterPerform = api.tasks.middleware[m].postProcessor }
            if (api.tasks.middleware[m].preEnqueue) { Plugin.beforeEnqueue = api.tasks.middleware[m].preEnqueue }
            if (api.tasks.middleware[m].postEnqueue) { Plugin.afterEnqueue = api.tasks.middleware[m].postEnqueue }
            plugins.push(Plugin)
          }
        }

        api.tasks.globalMiddleware.forEach(processMiddleware)
        middleware.forEach(processMiddleware)

        return {
          plugins: plugins,
          pluginOptions: pluginOptions,
          perform: async function () {
            let response = await api.tasks.tasks[taskName].run.apply(null, arguments)
            await api.tasks.enqueueRecurrentJob(taskName)
            return response
          }
        }
      },

      validateTask: (task) => {
        const fail = (msg) => {
          api.log(msg, 'emerg')
        }

        if (typeof task.name !== 'string' || task.name.length < 1) {
          fail('a task is missing \'task.name\'')
          return false
        } else if (typeof task.description !== 'string' || task.description.length < 1) {
          fail('Task ' + task.name + ' is missing \'task.description\'')
          return false
        } else if (typeof task.frequency !== 'number') {
          fail('Task ' + task.name + ' has no frequency')
          return false
        } else if (typeof task.queue !== 'string') {
          fail('Task ' + task.name + ' has no queue')
          return false
        } else if (typeof task.run !== 'function') {
          fail('Task ' + task.name + ' has no run method')
          return false
        } else {
          return true
        }
      },

      enqueue: async (taskName, params, queue) => {
        if (!params) { params = {} }
        if (!queue) { queue = api.tasks.tasks[taskName].queue }
        await api.resque.queue.enqueue(queue, taskName, params)
      },

      enqueueAt: async (timestamp, taskName, params, queue) => {
        if (!params) { params = {} }
        if (!queue) { queue = api.tasks.tasks[taskName].queue }
        return api.resque.queue.enqueueAt(timestamp, queue, taskName, params)
      },

      enqueueIn: async (time, taskName, params, queue) => {
        if (!params) { params = {} }
        if (!queue) { queue = api.tasks.tasks[taskName].queue }
        return api.resque.queue.enqueueIn(time, queue, taskName, params)
      },

      del: async (q, taskName, args, count) => {
        return api.resque.queue.del(q, taskName, args, count)
      },

      delDelayed: async (q, taskName, args) => {
        return api.resque.queue.delDelayed(q, taskName, args)
      },

      scheduledAt: async (q, taskName, args) => {
        return api.resque.queue.scheduledAt(q, taskName, args)
      },

      stats: async () => {
        return api.resque.queue.stats()
      },

      queued: async (q, start, stop) => {
        return api.resque.queue.queued(q, start, stop)
      },

      delQueue: async (q) => {
        return api.resque.queue.delQueue(q)
      },

      locks: async () => {
        return api.resque.queue.locks()
      },

      delLock: async (lock) => {
        return api.resque.queue.delLock(lock)
      },

      timestamps: async () => {
        return api.resque.queue.timestamps()
      },

      delayedAt: async (timestamp) => {
        return api.resque.queue.delayedAt(timestamp)
      },

      allDelayed: async (callback) => {
        return api.resque.queue.allDelayed()
      },

      workers: async (callback) => {
        return api.resque.queue.workers()
      },

      workingOn: async (workerName, queues) => {
        return api.resque.queue.workingOn(workerName, queues)
      },

      allWorkingOn: async () => {
        return api.resque.queue.allWorkingOn()
      },

      failedCount: async () => {
        return api.resque.queue.failedCount()
      },

      failed: async (start, stop) => {
        return api.resque.queue.failed(start, stop)
      },

      removeFailed: async (failedJob) => {
        return api.resque.queue.removeFailed(failedJob)
      },

      retryAndRemoveFailed: async (failedJob) => {
        return api.resque.queue.retryAndRemoveFailed(failedJob)
      },

      cleanOldWorkers: async (age) => {
        return api.resque.queue.cleanOldWorkers(age)
      },

      enqueueRecurrentJob: async (taskName) => {
        const task = api.tasks.tasks[taskName]

        if (task.frequency > 0) {
          await api.tasks.del(task.queue, taskName)
          await api.tasks.delDelayed(task.queue, taskName)
          await api.tasks.enqueueIn(task.frequency, taskName)
          api.log(`re-enqueued recurrent job ${taskName}`, api.config.tasks.schedulerLogging.reEnqueue)
        }
      },

      enqueueAllRecurrentJobs: async () => {
        let jobs = []
        let loadedTasks = []

        Object.keys(api.tasks.tasks).forEach((taskName) => {
          const task = api.tasks.tasks[taskName]
          if (task.frequency > 0) {
            jobs.push(async () => {
              let toRun = await api.tasks.enqueue(taskName)
              if (toRun === true) {
                api.log(`enqueuing periodic task: ${taskName}`, api.config.tasks.schedulerLogging.enqueue)
                loadedTasks.push(taskName)
              }
            })
          }
        })

        await api.utils.asyncWaterfall(jobs)
        return loadedTasks
      },

      stopRecurrentJob: async (taskName) => {
        // find the jobs in either the normal queue or delayed queues
        const task = api.tasks.tasks[taskName]
        if (task.frequency > 0) {
          let removedCount = 0
          let count = await api.tasks.del(task.queue, task.name, {}, 1)
          removedCount = removedCount + count
          let timestamps = await api.tasks.delDelayed(task.queue, task.name, {})
          removedCount = removedCount + timestamps.length
          return removedCount
        }
      },

      details: async () => {
        let details = {'queues': {}, 'workers': {}}

        details.workers = await api.tasks.allWorkingOn()
        details.stats = await api.tasks.stats()
        let queues = await api.resque.queue.queues()

        for (let i in queues) {
          let queue = queues[i]
          let length = await api.resque.queue.length(queue)
          details.queues[queue] = { length: length }
        }

        return details
      }
    }

    function loadTasks (reload) {
      api.config.general.paths.task.forEach((p) => {
        api.utils.recursiveDirectoryGlob(p).forEach((f) => {
          api.tasks.loadFile(f, reload)
        })
      })
    }

    api.tasks.addMiddleware = function (middleware) {
      if (!middleware.name) { throw new Error('middleware.name is required') }
      if (!middleware.priority) { middleware.priority = api.config.general.defaultMiddlewarePriority }
      middleware.priority = Number(middleware.priority)
      api.tasks.middleware[middleware.name] = middleware
      if (middleware.global === true) {
        api.tasks.globalMiddleware.push(middleware.name)
        api.utils.sortGlobalMiddleware(api.tasks.globalMiddleware, api.tasks.middleware)
      }
      loadTasks(true)
    }

    loadTasks(false)
  },

  start: async (api) => {
    if (api.config.redis.enabled === false) { return }

    if (api.config.tasks.scheduler === true) {
      await api.tasks.enqueueAllRecurrentJobs()
    }
  }
}
