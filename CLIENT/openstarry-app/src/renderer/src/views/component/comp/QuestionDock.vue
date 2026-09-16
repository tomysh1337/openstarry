<template>
  <section class="question-dock" aria-label="Agent 需要你回答" aria-live="polite">
    <header><strong>Agent 需要你回答</strong><span>{{ index + 1 }} / {{ questions.length }}</span></header>
    <div class="question-progress" aria-hidden="true"><i v-for="(_, step) in questions" :key="step" :class="{ complete: answered(step), current: step === index }" /></div>
    <Transition name="question-step" mode="out-in">
    <div :key="index" class="question-body">
    <p class="question-title">{{ current.question }}</p>
    <div class="question-options">
      <button v-for="(option, optionIndex) in current.options || []" :key="option" type="button"
        :aria-pressed="selected.includes(option)" :class="{ selected: selected.includes(option) }" :disabled="busy" @click="choose(option)">
        <span class="option-marker">{{ selected.includes(option) ? '✓' : optionIndex + 1 }}</span><span>{{ option }}</span>
      </button>
    </div>
    <textarea v-model="custom[index]" :disabled="busy" :aria-label="'补充回答：' + current.question" placeholder="补充说明（选填），也可以直接选择上方选项" rows="2" />
    </div>
    </Transition>
    <footer>
      <button type="button" :disabled="index === 0 || busy" @click="index--">上一题</button>
      <button type="button" :disabled="busy" @click="skip">{{ current.optional ? '跳过补充' : '暂时跳过此题' }}</button>
      <button v-if="index < questions.length - 1" type="button" :disabled="(!answered(index) && !current.optional) || busy" @click="index++">下一题</button>
      <button v-else type="button" class="question-submit" :disabled="!allAnswered || busy" @click="submit">{{ busy ? '正在提交…' : '提交回答并继续' }}</button>
    </footer>
    <p v-if="error" class="question-error" role="alert">{{ error }}</p>
  </section>
</template>
<script>
const questionDrafts = new Map()
</script>
<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ questions: { type: Array, required: true }, qid: { type: String, required: true }, onAnswer: { type: Function, required: true } })
const index = ref(0), choices = ref([]), custom = ref([]), skipped = ref([]), busy = ref(false), error = ref('')
watch(() => props.qid, id => {
  index.value = 0; error.value = ''
  if (!questionDrafts.has(id)) {
    if (questionDrafts.size >= 100) questionDrafts.delete(questionDrafts.keys().next().value)
    questionDrafts.set(id, { choices: props.questions.map(() => []), custom: props.questions.map(() => ''), skipped: props.questions.map(() => false) })
  }
  const saved = questionDrafts.get(id); choices.value = saved.choices; custom.value = saved.custom; skipped.value = saved.skipped
}, { immediate: true })
const current = computed(() => props.questions[index.value] || {})
const selected = computed(() => choices.value[index.value] || [])
const answered = i => Boolean(choices.value[i]?.length || custom.value[i]?.trim() || skipped.value[i])
const allAnswered = computed(() => props.questions.every((q, i) => q.optional || answered(i)))
function skip() { skipped.value[index.value] = true; if (index.value < props.questions.length - 1) index.value++ }
function choose(option) {
  skipped.value[index.value] = false
  const current = choices.value[index.value]
  if (props.questions[index.value].multiselection) choices.value[index.value] = current.includes(option) ? current.filter(value => value !== option) : [...current, option]
  else choices.value[index.value] = [option]
}
async function submit() {
  if (!allAnswered.value || busy.value) return
  busy.value = true; error.value = ''
  try { await props.onAnswer(props.qid, props.questions.map((q, i) => ({ question: q.question, response: choices.value[i].length || custom.value[i].trim() ? [...choices.value[i], ...(custom.value[i].trim() ? [custom.value[i].trim()] : [])] : ['用户跳过此题，未提供补充'] }))); questionDrafts.delete(props.qid) }
  catch (err) { error.value = err.message || '提交失败，答案已保留，请重试' }
  finally { busy.value = false }
}
</script>
<style scoped>
.question-dock { width: min(840px, calc(100% - 32px)); flex-shrink: 0; min-width: 0; background: var(--OpenStarry-panel-layer-3-background); color: var(--OpenStarry-default-dark-color); border: 1px solid color-mix(in srgb, var(--OpenStarry-primary-color) 45%, transparent); border-radius: 16px; padding: 20px 24px; margin: 10px 0; max-height: min(48vh, 420px); overflow: auto; box-sizing: border-box; }
header, footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; justify-content: space-between; }
header { font-size: 13px; } header span { opacity: .65; }
.question-title { font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; margin: 14px 0 10px; }
.question-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 10px; }
button { cursor: pointer; font: inherit; border: 1px solid var(--OpenStarry-default-light-color); background: transparent; color: inherit; border-radius: 10px; padding: 9px 12px; transition: background-color 160ms, border-color 160ms, transform 200ms var(--motion-settle); }
.question-options button { display: flex; gap: 10px; text-align: left; align-items: center; font-size: 13px; overflow-wrap: anywhere; }
.option-marker { display: grid; place-items: center; width: 23px; height: 23px; flex-shrink: 0; border-radius: 7px; background: color-mix(in srgb, currentColor 7%, transparent); transition: background-color 180ms, color 180ms, transform 240ms var(--motion-settle); }
.selected .option-marker { background: var(--OpenStarry-primary-color); color: white; transform: scale(1.06); }
.question-options button:hover:not(:disabled) { background: color-mix(in srgb, var(--OpenStarry-primary-color) 7%, transparent); }
button:active:not(:disabled) { transform: scale(.985); }
button.selected { border-color: var(--OpenStarry-primary-color); background: color-mix(in srgb, var(--OpenStarry-primary-color) 12%, transparent); }
textarea { box-sizing: border-box; width: 100%; margin: 10px 0; min-height: 54px; border: 1px solid var(--OpenStarry-default-light-color); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-size: 13px; padding: 10px; resize: vertical; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--OpenStarry-primary-color); outline-offset: 2px; }
.question-submit { background: var(--OpenStarry-primary-color); color: white; }
button:disabled { opacity: .5; cursor: default; }
.question-error { color: var(--OpenStarry-danger-color); font-size: 12px; }
.question-progress { display: flex; gap: 5px; margin-top: 14px; }
.question-progress i { flex: 1; height: 3px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
.question-progress i::after { content: ''; display: block; height: 100%; background: var(--OpenStarry-primary-color); transform: scaleX(0); transform-origin: left; transition: transform 300ms var(--motion-settle), opacity 200ms; }
.question-progress .current::after { transform: scaleX(1); opacity: .5; }
.question-progress .complete::after { transform: scaleX(1); opacity: 1; }
.question-step-enter-active { transition: opacity 200ms, transform 240ms var(--motion-settle); }
.question-step-leave-active { transition: opacity 80ms; }
.question-step-enter-from { opacity: 0; transform: translateX(10px); }
.question-step-leave-to { opacity: 0; }
@media (max-width: 600px) { .question-dock { padding: 16px; } }
@media (prefers-reduced-motion: reduce) { button:active:not(:disabled), .selected .option-marker { transform: none; } }
</style>
