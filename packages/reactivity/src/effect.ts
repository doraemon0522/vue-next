import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, extend, isArray } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol('iterate')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn != null && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(...args: unknown[]): unknown {
    return run(effect, fn, args)
  } as ReactiveEffect
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

function run(effect: ReactiveEffect, fn: Function, args: unknown[]): unknown {
  if (!effect.active) {
    return fn(...args)
  }
  // includes的情况是：监听函数中，又改变了依赖数据，就会递归循环，加判断排除掉
  if (!effectStack.includes(effect)) {
    cleanup(effect)
    // try...finally的执行顺序:finally在try之后运行
    // 首先try块中的effectStack.push(effect)会最先执行
    // 这条语句不会报错，接下来返回调用fn
    // 如果这时候退出了函数，意味者finally不会运行代码。
    // 这里的return被推迟到了finally结束后，但fn(..args)也是在try块中调用的
    // 下面代码的调用顺序是:effectStack.push(effect) -> TemporarySave=fn(...args) -> 
    // effectStack.pop() -> return TemporarySave
    try {
      enableTracking()
      effectStack.push(effect)
      activeEffect = effect
      //fn内引用了依赖数据，执行时，触发这些数据的get,从而走到track，因此effectStack堆栈尾部正好是该effect
      return fn(...args)
    } finally {
      effectStack.pop()
      resetTracking()
      activeEffect = effectStack[effectStack.length - 1]
    }
  }
}

function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  let depsMap = targetMap.get(target)
  if (depsMap === void 0) {
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  if (dep === void 0) {
    depsMap.set(key, (dep = new Set()))
  }
  if (!dep.has(activeEffect)) {
    // 双向存法 需要仔细理解~~
    // 对于一个响应式数据，它在targetMap中存着一个Map数据（我称之为「响应依赖映射」）。
    // 这个响应依赖映射的key是该响应式数据的某个属性值，value是所有用到这个响应数据属性值的所有监听函数，也即是Set集合dep。
    dep.add(activeEffect)
    // 而对于一个监听函数，它会存放着 所有存着它自身的dep。
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (depsMap === void 0) {
    // never been tracked
    return
  }
  const effects = new Set<ReactiveEffect>()
  const computedRunners = new Set<ReactiveEffect>()
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(dep => {
      addRunners(effects, computedRunners, dep)
    })
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        addRunners(effects, computedRunners, dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      addRunners(effects, computedRunners, depsMap.get(key))
    }
    // also run for iteration key on ADD | DELETE | Map.SET
    if (
      type === TriggerOpTypes.ADD ||
      type === TriggerOpTypes.DELETE ||
      (type === TriggerOpTypes.SET && target instanceof Map)
    ) {
      const iterationKey = isArray(target) ? 'length' : ITERATE_KEY
      addRunners(effects, computedRunners, depsMap.get(iterationKey))
    }
  }
  const run = (effect: ReactiveEffect) => {
    scheduleRun(
      effect,
      target,
      type,
      key,
      __DEV__
        ? {
            newValue,
            oldValue,
            oldTarget
          }
        : undefined
    )
  }
  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  computedRunners.forEach(run)
  effects.forEach(run)
}

function addRunners(
  effects: Set<ReactiveEffect>,
  computedRunners: Set<ReactiveEffect>,
  effectsToAdd: Set<ReactiveEffect> | undefined
) {
  if (effectsToAdd !== void 0) {
    effectsToAdd.forEach(effect => {
      if (effect !== activeEffect) {
        if (effect.options.computed) {
          computedRunners.add(effect)
        } else {
          effects.add(effect)
        }
      } else {
        // the effect mutated its own dependency during its execution.
        // this can be caused by operations like foo.value++
        // do not trigger or we end in an infinite loop
      }
    })
  }
}

function scheduleRun(
  effect: ReactiveEffect,
  target: object,
  type: TriggerOpTypes,
  key: unknown,
  extraInfo?: DebuggerEventExtraInfo
) {
  if (__DEV__ && effect.options.onTrigger) {
    const event: DebuggerEvent = {
      effect,
      target,
      key,
      type
    }
    effect.options.onTrigger(extraInfo ? extend(event, extraInfo) : event)
  }
  if (effect.options.scheduler !== void 0) {
    effect.options.scheduler(effect)
  } else {
    effect()
  }
}
