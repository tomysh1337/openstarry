import { expect } from '@playwright/test'
import assert from 'node:assert/strict'

// Called with the real IDE picker open; no animation disabling or mocked pointer events.
export async function verifyReasoningMotion(page, shots, host) {
  const popup = page.getByRole('dialog', { name: '选择思考等级' })
  const slider = popup.getByRole('slider', { name: '思考等级滑杆' })
  const track = popup.locator('.os-reasoning-track')
  const thumb = popup.locator('.os-reasoning-thumb')
  const progress = () => thumb.evaluate(element => (parseFloat(getComputedStyle(element).left) - 14) / (element.parentElement.clientWidth - 28))
  const settled = async index => {
    try { await expect.poll(async () => Math.abs(await progress() - index / 4)).toBeLessThan(.005) }
    catch (error) {
      console.error('Slider layout:', await page.evaluate(() => {
        const thumb = document.querySelector('.os-reasoning-thumb'), track = document.querySelector('.os-reasoning-track')
        return { left: thumb && getComputedStyle(thumb).left, width: track?.clientWidth, style: track?.getAttribute('style'), markup: track?.outerHTML }
      }))
      throw error
    }
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await popup.getByRole('button', { name: '低', exact: true }).click()
  await settled(0)

  const frames = await popup.evaluate(async element => {
    const thumb = element.querySelector('.os-reasoning-thumb')
    const read = () => parseFloat(getComputedStyle(thumb).left)
    const frames = [read()]
    element.querySelector('.os-reasoning-choices button:last-child').click()
    const started = performance.now()
    while (performance.now() - started < 360) {
      await new Promise(requestAnimationFrame); frames.push(read())
    }
    return frames
  })
  assert.ok(frames.at(-1) - frames[0] > 150, 'label selection crosses the whole five-level track')
  assert.ok(frames.filter(left => left > frames[0] + 1 && left < frames.at(-1) - 1).length >= 3, 'label selection renders multiple intermediate animation frames')
  await settled(4)

  await slider.press('Home'); await settled(0)
  let rect = await track.boundingBox()
  const x = fraction => rect.x + 14 + (rect.width - 28) * fraction
  const y = () => rect.y + rect.height / 2
  await page.mouse.move(x(0), y()); await page.mouse.down()
  for (const fraction of [.11, .27, .46, .66, .89]) {
    await page.mouse.move(x(fraction), y())
    assert.ok(Math.abs(await progress() - fraction) < .012, 'mouse drag follows the pointer between detents')
    await expect(slider).toHaveValue(String(Math.round(fraction * 4)))
    await expect(track).toHaveAttribute('data-dragging', 'true')
  }
  const snapFrames = thumb.evaluate(async element => {
    const frames = [], started = performance.now()
    while (performance.now() - started < 420) {
      frames.push(parseFloat(getComputedStyle(element).left))
      await new Promise(requestAnimationFrame)
    }
    return frames
  })
  await page.mouse.up()
  const snap = await snapFrames
  assert.ok(snap.some(left => left > 14 + (rect.width - 28) * .90 && left < rect.width - 15), 'release renders intermediate snap positions')
  await settled(4); await expect(track).not.toHaveAttribute('data-dragging')
  await expect(slider).toHaveAttribute('aria-valuetext', 'Ultra')
  await slider.press('ArrowLeft'); await settled(3)
  await expect(slider).toHaveAttribute('aria-valuetext', '极高')
  await slider.press('End'); await settled(4)

  const flowState = () => popup.evaluate(element => {
    const flow = element.querySelector('.os-reasoning-flow'), stars = element.querySelector('.os-reasoning-stars')
    return [getComputedStyle(flow, '::before').transform, getComputedStyle(stars, '::before').transform, getComputedStyle(stars, '::after').transform, getComputedStyle(element.querySelector('strong')).backgroundPosition]
  })
  const first = await flowState()
  const firstImage = await popup.screenshot({ path: `${shots}/${host}-motion-a.png`, animations: 'allow' })
  await page.waitForTimeout(240)
  const second = await flowState()
  const secondImage = await popup.screenshot({ path: `${shots}/${host}-motion-b.png`, animations: 'allow' })
  first.forEach((value, index) => assert.notEqual(value, second[index], 'Ultra light, star layers and caption move over time'))
  assert.notDeepEqual(firstImage, secondImage, 'rendered Ultra frames visibly change')

  const viewport = page.viewportSize()
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await popup.getByRole('button', { name: '恢复中等思考' }).click(); await settled(1)
    rect = await track.boundingBox()
    const touch = (type, fraction) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: fraction == null ? [] : [{ x: x(fraction), y: y(), id: 1 }] })
    await touch('touchStart', .25)
    for (const fraction of [.39, .56, .69]) {
      await touch('touchMove', fraction)
      await expect.poll(async () => Math.abs(await progress() - fraction)).toBeLessThan(.02)
    }
    await touch('touchEnd'); await settled(3)
    await expect(slider).toHaveAttribute('aria-valuetext', '极高')
    await touch('touchStart', .75); await touch('touchMove', .61)
    await touch('touchCancel'); await settled(2)
    await expect(track).not.toHaveAttribute('data-pressed')
    await slider.press('End'); await settled(4)
    await page.screenshot({ path: `${shots}/${host}-motion-touch.png`, animations: 'allow' })
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach(); await page.setViewportSize(viewport)
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await popup.evaluate(element => ({
    thumbTransition: getComputedStyle(element.querySelector('.os-reasoning-thumb')).transitionDuration,
    animations: [
      getComputedStyle(element.querySelector('.os-reasoning-flow'), '::before').animationName,
      getComputedStyle(element.querySelector('.os-reasoning-flow'), '::after').animationName,
      getComputedStyle(element.querySelector('.os-reasoning-stars'), '::before').animationName,
      getComputedStyle(element.querySelector('.os-reasoning-stars'), '::after').animationName,
      getComputedStyle(document.querySelector('.os-reasoning-caption')).animationName,
    ],
  }))
  // The mobile shell clamps all transitions to 0.01ms instead of removing them.
  assert.ok(parseFloat(reduced.thumbTransition) < .001, 'reduced-motion transitions are effectively immediate')
  assert.ok(reduced.animations.every(name => name === 'none'), 'reduced motion disables every continuous layer')
  await slider.press('Home')
  await expect(slider).toHaveValue('0')
  await settled(0)
  await slider.press('End'); await settled(4)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  console.log('PASS: animated detents, continuous mouse/touch drag, release snap, touch cancel, keyboard, moving Ultra pixels, reduced motion')
}
