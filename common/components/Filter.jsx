import {AS_IS, preserveState, unconscious} from "unconscious";
import './filter.css';

const DEFAULT_REQUIRE_FUNC = (name, item) => {
	if (!name) return item.warning || '字段不得留空';
}

/**
 * @param {Config[]} config 配置列表
 * @param {Record<string, any> | Reactive<Record<string, any>>} [choices] 默认选项值，默认空数组
 * @param {boolean} [fillPlaceholder=true] 是否用 placeholder 填充 textbox
 * @param {(value: string, data: any, choices: Record<string, any>) => void | string} onChange 回调函数
 * @return {FilterInstance}
 */
export function Filter({config, choices, onChange, fillPlaceholder = true}) {
	config.forEach(item => {
		const {id, type} = item;

		switch (type) {
			case 'input':
			case 'textbox': choices[id] = choices[id] ?? ''; break;
			case 'multiple': if (id) choices[id] = choices[id] ?? []; break;
			case 'range': {
				const min = item.min, max = item.max;
				const clamp = (v) => Math.max(min, Math.min(max, v));

				const init = choices[id];
				choices[id] = init
					? [
						clamp(Number(init[0] ?? min)),
						clamp(Number(init[1] ?? max))
					].sort((a, b) => a - b)
					: [min, max];
			}
			break;
			case 'number': {
				const min = item.min, max = item.max;
				const clamp = (v) => Math.max(min, Math.min(max, v));

				const init = choices[id];
				choices[id] = clamp(Number.isFinite(init) ? init : item.default);
			}
			break;
			case "radio":
				if (item.required) {
					const init = choices[id];
					const values = Object.values(item.choices);
					const off = values.indexOf(init);
					if (off < 0) choices[id] = values[0];
				}
			break;
		}
	});

	const state = preserveState(choices);
	const emit = (name, newValue) => {
		let result;
		try {
			result = onChange?.(name, newValue, state, div);
		} catch (e) {
			result = e;
		}
		return result;
	}

	// 构建每一项
	const refreshHandlers = [];
	function addRefreshHandler(id, callback, dontCall) {
		if (!dontCall) callback();
		refreshHandlers.push(callback);
	}
	function sync(initial, noemit) {
		if (!initial) {
			for (const item of refreshHandlers) {
				item();
			}
		}

		if (!noemit) {
			const objects = unconscious(choices);
			for (const key in objects) {
				emit(key, objects[key]);
			}
		}
	}

	const itemRenderer = item => {
		const {type, id, name, title, load = AS_IS, save = AS_IS} = item;
		let row, warning;

		function showWarning(text) {
			if (warning?.parentElement) warning.innerText = text;
			else row.append(warning = <div className='input-warning' aria-live='polite'>{text}</div>);
		}

		switch (type) {
			case 'element': {
				row = item.element;
			}
			break;
			case 'radio': {
				const required = !!item.required;
				const handler = ({target: btn}) => {
					let value = item.choices[btn.firstChild.textContent];

					value = load(state[id]) === value ? undefined : value;
					if (value === undefined && required) return;

					let err = emit(id, value);
					if (err) {
						showWarning(err);
						return;
					}
					warning?.remove();

					const cur = row.querySelector('.active');
					if (cur) {
						cur.classList.remove('active');
						cur.setAttribute('aria-checked', 'false');
					}

					if (value !== undefined) {
						// 更新同组样式
						btn.classList.add('active');
						btn.setAttribute('aria-checked', 'true');
					}

					state[id] = save(value);
				};

				const initState = load(state[id]);
				row = <div className={'choice-scroll'+(required?" radio":"")} role='radiogroup' aria-label={name} onClick.children{'button'}={handler}>
					{Object.entries(item.choices).map(([label, value]) => {
						const active = initState === value;
							return <button className={active ? 'chip active' : 'chip'} _val={value}
										   type='button' role='radio' aria-checked={active}
										   title={title?.[label]}
							>{label}{title?.[label] && <div className={"tooltip"}>{title[label]}</div>}</button>;
						})}
				</div>;

				addRefreshHandler(id, () => {
					const value = load(state[id]);
					for (let child of row.children) {
						child.classList.toggle('active', value === child._val);
					}
				}, true);
			}
			break;
			case 'multiple': {
				const handler = ({target: btn}) => {
					const value = item.choices[btn.firstChild.textContent];

					let selectedNow;
					if (id) {
						const arr = [...state[id]];

						const idx = arr.indexOf(value);

						selectedNow = idx < 0;
						if (selectedNow) arr.push(value);
						else arr.splice(idx, 1);

						let err = emit(id, arr);
						if (err) {
							showWarning(err);
							return;
						}
						warning?.remove();

						state[id] = arr;
					} else {
						let err = emit(value, !state[value]);
						if (err) {
							showWarning(err);
							return;
						}
						warning?.remove();

						selectedNow = state[value] ^= true;
					}

					btn.classList.toggle('active', selectedNow);
					btn.setAttribute('aria-checked', !!selectedNow);
				};

				row = <div className='choice-scroll' role='group' aria-label={name} onClick.children{'button'}={handler}>
					{Object.entries(item.choices).map(([label, value]) => {
							const selected = id ? state[id].includes(value) : !!state[value];
							return (<button className={selected ? 'chip active' : 'chip'} type='button' name={value}
											role='checkbox' aria-checked={selected}
											title={title?.[label]}
									>{label}{title?.[label] && <div className={"tooltip"}>{title[label]}</div>}</button>);
						})}
				</div>;

				addRefreshHandler(id, () => {
					for (let child of row.children) {
						const value = child.name;
						child.classList.toggle('active', id ? state[id].includes(value) : !!state[value]);
					}
				}, true);
			}
			break;
			case 'secret':
			case 'input':
			case 'textbox': {
				const {pattern: pat = DEFAULT_REQUIRE_FUNC} = item;

				const pattern = typeof pat === 'string'
					? new RegExp(pat)
					: pat;

				/**
				 * @type {string}
				 */
				let value;
				const isInvalid = pattern instanceof RegExp
					? (val) => !pattern.test(val) && (item.warning || '输入不符合要求')
					: (val) => {
						try {
							let error = pattern(val, item);
							if (Array.isArray(error))
								[value, error] = error;
							return error;
						} catch (e) {
							return e.message ?? e;
						}
					};

				/** @type {HTMLInputElement | HTMLTextAreaElement} */
				let input;
				const handler = e => {
					const doSubmit = e.type === 'change';
					value = input.value;//.trim();
					let invalid = pattern && (value || item.required) && isInvalid(value);
					if (invalid) {
						if (doSubmit) {
							input.value = load(state[id]);
							invalid = false;
						}
					} else if (e.type) {
						invalid = emit(id, value);
						if (!invalid && doSubmit) state[id] = save(value);
					}
					input.classList.toggle('invalid', !!invalid);

					if (invalid) showWarning(invalid);
					else warning?.remove();
				};

				if (item.type === 'secret') {
					input = <input className='text-input' type='password' placeholder={item.placeholder}
							   onBlur={function(){this.type="password"}} onFocus={function(){this.type="text"}}
							   onInput={handler} onChange={handler} autoComplete="off" />;
				} else if (item.type === 'input') {
					input = <input className='text-input' type='text' placeholder={item.placeholder}
							   onInput={handler} onChange={handler} autoComplete="off" />;
				} else {
					let filled = !fillPlaceholder;
					const onFocusBlur = e => {
						const isFocus = e.type === "focus";
						if (isFocus && !filled && item.placeholder) {
							if (!input.value) input.value = item.placeholder;
							filled = true;
						}
						input.style.height = isFocus ? "500px" : "";
					};

					input = <textarea className='text-input' placeholder={item.placeholder}
									  onInput={handler} onChange={handler}
									  onFocus={onFocusBlur} onBlur={onFocusBlur} />;
				}

				row = <div className='input-warp'>{input}</div>;
				addRefreshHandler(id, () => {input.value = load(state[id]) ?? ''; handler({})});
			}
			break;
			case 'number': {
				const min = item.min, max = item.max, step = item.step || 1;

				const clamp = (v) => Math.max(min, Math.min(max, v));
				const pct = (v) => ((v - min) / (max - min)) * 100;

				const trackFill = <div className='range-track-fill' />;

				let isZero;
				const updateUI = () => {
					const myMin = slider.valueAsNumber;
					if (input.value !== String(myMin))
						input.valueAsNumber = myMin;
					isZero = !myMin;
					trackFill.style.width = `${pct(myMin)}%`;
				};
				const syncState = () => {
					let newValue = slider.valueAsNumber;
					if (step !== 1) newValue = Math.round(newValue / step) * step;
					emit(id, newValue);
					state[id] = newValue;
				};

				const limitMax = e => {
					const value = e.target.value;
					slider.value = clamp(Number(isZero && e.inputType === 'insertText' ? value.replace("0", "") : value));
					updateUI();
				};

				const slider = <input type='range' min={min} max={max} step={step>1?1:step} onInput={step !== 1 ? () => {
					slider.value = Math.round(slider.valueAsNumber / step) * step;
					updateUI();
				} : updateUI} onChange={syncState} />;
				const input = <input type='number' min={min} max={max} step={step} onInput={limitMax} onChange={syncState} />;

				row = <div className='range-wrap'>
					<div className='range-slider'>
						<div className='range-track-bg'></div>
						{trackFill}
						{slider}
					</div>
					<div className='range-values'>
						<span>值</span>{input}
					</div>
				</div>;

				addRefreshHandler(id, () => {
					const value = state[id];
					slider.valueAsNumber = clamp(value);
					updateUI();
				});
			}
			break;
			case 'range': {
				const min = item.min, max = item.max, step = item.step || 1;

				const clamp = (v) => Math.max(min, Math.min(max, v));
				const pct = (v) => ((v - min) / (max - min)) * 100;

				let minIsZero, maxIsZero;
				const updateUI = () => {
					const myMin = r1.valueAsNumber;
					const myMax = r2.valueAsNumber;

					if (nMin.value !== String(myMin))
						nMin.valueAsNumber = myMin;
					if (nMax.value !== String(myMax))
						nMax.valueAsNumber = myMax;
					minIsZero = !myMin;
					maxIsZero = !myMax;

					const left = pct(myMin), right = pct(myMax);
					trackFill.style.left = `${left}%`;
					trackFill.style.width = `${right - left}%`;
				};
				const syncState = () => {
					let newValue = [r1.valueAsNumber, r2.valueAsNumber];
					if (step !== 1) newValue = newValue.map(v => Math.round(v / step) * step);
					emit(id, newValue);
					state[id] = newValue;
				};

				const limitMax = e => {
					let value = clamp(Number(e.target.value));
					r1.value = Math.min(Number(minIsZero && e.inputType === 'insertText' ? value.replace("0", "") : value), r2.valueAsNumber);
					updateUI();
				};
				const limitMin = e => {
					let value = clamp(Number(e.target.value));
					r2.value = Math.max(Number(maxIsZero && e.inputType === 'insertText' ? value.replace("0", "") : value), r1.valueAsNumber);
					updateUI();
				};

				const trackFill = <div className='range-track-fill' />;

				const r1 = <input type='range' min={min} max={max} step={step>1?1:step} onInput={step !== 1 ? () => {
					r1.value = Math.round(r1.valueAsNumber / step) * step;
					updateUI();
				} : updateUI} onChange={syncState} />;
				const r2 = <input type='range' min={min} max={max} step={step>1?1:step} onInput={step !== 1 ? () => {
					r2.value = Math.round(r2.valueAsNumber / step) * step;
					updateUI();
				} : updateUI} onChange={syncState} />;

				const nMin = <input type='number' min={min} max={max} onInput={limitMax} onChange={syncState} />;
				const nMax = <input type='number' min={min} max={max} onInput={limitMin} onChange={syncState} />;

				row = <div className='range-wrap'>
					<div className='range-slider'>
						<div className='range-track-bg'></div>
						{trackFill}
						{r1}
						{r2}
					</div>
					<div className='range-values'>
						<span>最小</span>{nMin}
						<span>最大</span>{nMax}
					</div>
				</div>;

				addRefreshHandler(id, () => {
					[r1.valueAsNumber, r2.valueAsNumber] = state[id];
					updateUI();
				});
			}
			break;
		}

		const isString = typeof id === "string";
		return (<div className="filter-row" data-id={isString ? id : undefined} _key={id}>
			{name && (<>
					<div className="filter-label">{name}</div>
					{typeof title === "string" && <div className="filter-label secondary">{title}</div>}
				</>)}
			{row}
		</div>);
	};

	const div = <div className="filter">{config.map(itemRenderer)}</div>;
	div.sync = sync;
	div.hasError = () => div.querySelector(".input-warning")
	return div;
}

export default Filter;