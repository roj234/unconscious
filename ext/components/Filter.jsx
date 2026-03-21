import {isReactive, preserveState, unconscious} from "unconscious";
import './filter.css';

/**
 * @typedef {Object} Config
 * @property {string} id
 * @property {string} name
 * @property {string} type
 */

/**
 * @typedef {HTMLDivElement} Filter
 * @property {(initial: boolean=false) => void} _onSettingsUpdated
 */

/**
 * @param {Config[]} config 配置列表
 * @param {Object[]} choices={} 选项值
 * @param {function(string, any, Object[]): void|string} onChange=null 回调
 * @return {Filter}
 */
export default function Filter({config, choices, onChange}) {
	const initialState = isReactive(choices) ? choices : Object.assign({}, choices);
	config.forEach(item => {
		switch (item.type) {
			case 'input':
			case 'textbox': initialState[item.id] = initialState[item.id] ?? ''; break;
			case 'multiple': if (item.id) initialState[item.id] = initialState[item.id] ?? []; break;
			case 'range': {
				const min = item.min, max = item.max;
				const clamp = (v) => Math.max(min, Math.min(max, v));

				const init = initialState[item.id];
				initialState[item.id] = init
					? [
						clamp(Number(init[0] ?? min)),
						clamp(Number(init[1] ?? max))
					].sort((a, b) => a - b)
					: [min, max];
			}
			break;
		}
	});

	const state = preserveState(initialState);
	const emit = (name, newValue) => {
		let result;
		try {
			result = onChange?.(name, newValue, state);
		} catch (e) {
			result = e;
		}
		return result;
	}

	// 构建每一项
	const refreshHandlers = [];
	function addRefreshHandler(id, callback, dontCall) {
		if (!dontCall) callback();
		if (isReactive(choices)) refreshHandlers.push(callback);
	}
	function onSettingsUpdated(initial) {
		if (!initial) {
			for (const item of refreshHandlers) {
				item();
			}
		}

		const objects = unconscious(choices);
		for (const key in objects) {
			emit(key, objects[key]);
		}
	}

	const itemRenderer = item => {
		let row, warning;

		function showWarning(text) {
			if (warning) warning.innerText = text;
			else {
				warning = <div className='input-warning' aria-live='polite'>{text}</div>;
				row.append(warning);
			}
		}

		switch (item.type) {
			case 'element': {
				row = item.element;
			}
			break;
			case 'radio': {
				const required = !!item.required;
				const handler = ({target: btn}) => {
					let value = item.choices[btn.textContent];

					value = state[item.id] === value ? null : value;
					if (value == null && required) return;

					let err = emit(item.id, value);
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

					if (value != null) {
						// 更新同组样式
						btn.classList.add('active');
						btn.setAttribute('aria-checked', 'true');
					}

					state[item.id] = value;
				};

				row = <div className='choice-scroll' role='radiogroup' aria-label={item.name} onClick.children{'button'}={handler}>
					{Object.entries(item.choices).map(([label, value]) => {
							const active = state[item.id] === value;
							return <button className={active ? 'chip active' : 'chip'} _val={value}
										   type='button' role='radio' aria-checked={active}
										   title={item.title?.[label] || label}>{label}</button>;
						})}
				</div>;

				addRefreshHandler(item.id, () => {
					const value = state[item.id];
					for (let child of row.children) {
						child.classList.toggle('active', value === child._val);
					}
				}, true);
			}
			break;
			case 'multiple': {
				const handler = ({target: btn}) => {
					const value = item.choices[btn.textContent];

					let selectedNow;
					if (item.id) {
						const arr = [...state[item.id]];

						const idx = arr.indexOf(value);

						selectedNow = idx < 0;
						if (selectedNow) arr.push(value);
						else arr.splice(idx, 1);

						let err = emit(item.id, arr);
						if (err) {
							showWarning(err);
							return;
						}
						warning?.remove();

						state[item.id] = arr;
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

				row = <div className='choice-scroll' role='group' aria-label={item.name} onClick.children{'button'}={handler}>
					{Object.entries(item.choices).map(([label, value]) => {
							const selected = item.id ? state[item.id].includes(value) : !!state[value];
							return (<button className={selected ? 'chip active' : 'chip'} type='button' name={value}
											role='checkbox' aria-checked={selected}
											title={item.title?.[label] || label}>{label}</button>);
						})}
				</div>;

				addRefreshHandler(item.id, () => {
					for (let child of row.children) {
						const value = child.name;
						child.classList.toggle('active', item.id ? state[item.id].includes(value) : !!state[value]);
					}
				}, true);
			}
			break;
			case 'secret':
			case 'input': {
				const pattern =
					item.pattern instanceof RegExp
						? item.pattern
						: typeof item.pattern === 'string'
							? new RegExp(item.pattern)
							: null;

				const handler = (e) => {
					const doSubmit = e.type === 'change';
					const val = input.value.trim();
					let invalid = pattern && val && !pattern.test(val);
					let warnMessage = item.warning || '输入不符合要求';
					if (invalid) {
						if (doSubmit) {
							input.value = state[item.id];
							invalid = false;
						}
					} else {
						warnMessage = emit(item.id, val);
						if (warnMessage) invalid = true;
						else if (doSubmit) state[item.id] = val;
					}
					input.classList.toggle('invalid', invalid);

					if (invalid) showWarning(warnMessage);
					else warning?.remove();
				};

				let input;
				if (item.type === 'secret') {
					input = <input className='text-input' type='password' placeholder={item.placeholder || ''}
							   onBlur={function(){this.type="password"}} onFocus={function(){this.type="text"}}
							   onInput={handler} onChange={handler}/>;
				} else {
					input = <input className='text-input' type='text' placeholder={item.placeholder || ''}
							   onInput={handler} onChange={handler}/>;
				}

				addRefreshHandler(item.id, () => {input.value = state[item.id];});
				row = <div className='input-warp'>{input}</div>;
			}
			break;
			case 'textbox': {
				const pattern =
					item.pattern instanceof RegExp
						? item.pattern
						: typeof item.pattern === 'string'
							? new RegExp(item.pattern)
							: null;

				const handler = e => {
					const doSubmit = e.type === 'change';
					const val = input.value.trim();
					let invalid = pattern && val && !pattern.test(val);
					let warnMessage = item.warning || '输入不符合要求';
					if (invalid) {
						if (doSubmit) {
							input.value = state[item.id];
							invalid = false;
						}
					} else {
						warnMessage = emit(item.id, val);
						if (warnMessage) invalid = true;
						else if (doSubmit) state[item.id] = val;
					}
					input.classList.toggle('invalid', invalid);

					if (invalid) showWarning(warnMessage);
					else warning?.remove();
				};

				const onFocusBlur = e => {
					input.style.height = e.type === "focus" ? "500px" : "";
				};

				const input = <textarea className='text-input' placeholder={item.placeholder || ''} onInput={handler} onChange={handler} onFocus={onFocusBlur} onBlur={onFocusBlur}></textarea>;

				addRefreshHandler(item.id, () => {input.value = state[item.id];});
				row = <div className='input-warp'>{input}</div>;
			}
			break;
			case 'number': {
				const min = item.min, max = item.max, step = item.step || 1;

				const clamp = (v) => Math.max(min, Math.min(max, v));
				const pct = (v) => ((v - min) / (max - min)) * 100;

				const trackFill = <div className='range-track-fill'></div>;

				const slider = <input type='range' min={min} max={max} step={step} />;
				const input = <input type='number' min={min} max={max} step={step} />;

				const updateUI = () => {
					const myMin = slider.valueAsNumber;
					input.valueAsNumber = myMin;
					trackFill.style.width = `${pct(myMin)}%`;
				};
				const syncState = () => {
					const newValue = slider.valueAsNumber;
					emit(item.id, newValue);
					state[item.id] = newValue;
				};

				const limitMax = e => {
					slider.valueAsNumber = clamp(Number(e.target.value));
					updateUI();
				};

				slider.addEventListener('input', limitMax);
				input.addEventListener('input', limitMax);

				slider.addEventListener('change', syncState);
				input.addEventListener('change', syncState);

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

				addRefreshHandler(item.id, () => {
					const value = state[item.id];
					slider.valueAsNumber = clamp(value);
					updateUI();
				});
			}
			break;
			case 'range': {
				const min = item.min, max = item.max, step = item.step || 1;

				const clamp = (v) => Math.max(min, Math.min(max, v));
				const pct = (v) => ((v - min) / (max - min)) * 100;

				const updateUI = () => {
					const myMin = r1.valueAsNumber;
					const myMax = r2.valueAsNumber;

					nMin.valueAsNumber = myMin;
					nMax.valueAsNumber = myMax;

					const left = pct(myMin), right = pct(myMax);
					trackFill.style.left = `${left}%`;
					trackFill.style.width = `${right - left}%`;
				};
				const syncState = () => {
					const newValue = [r1.valueAsNumber, r2.valueAsNumber];
					emit(item.id, newValue);
					state[item.id] = newValue;
				};

				const limitMax = e => {
					let v = clamp(Number(e.target.value));
					r1.valueAsNumber = Math.min(v, r2.valueAsNumber);
					updateUI();
				};
				const limitMin = e => {
					let v = clamp(Number(e.target.value));
					r2.valueAsNumber = Math.max(v, r1.valueAsNumber);
					updateUI();
				};

				const trackFill = <div className='range-track-fill'></div>;

				const r1 = <input type='range' min={min} max={max} step={step} onInput={limitMax} onChange={syncState} />;
				const r2 = <input type='range' min={min} max={max} step={step} onInput={limitMin} onChange={syncState} />;

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

				addRefreshHandler(item.id, () => {
					[r1.valueAsNumber, r2.valueAsNumber] = state[item.id];
					updateUI();
				});
			}
			break;
		}

		return (<div className="filter-row" data-id={item.id}>
			<div className="filter-label">{item.name}</div>
			{row}
		</div>);
	};

	return <div _onSettingsUpdated={onSettingsUpdated} className="filter">{config.map(itemRenderer)}</div>;
};
