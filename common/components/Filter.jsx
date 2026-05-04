import {AS_IS, isReactive, preserveState, unconscious} from "unconscious";
import './filter.css';

/**
 * @typedef {Object} Config
 * @property {string} id
 * @property {string} name
 * @property {string} type
 */

/**
 * @typedef {HTMLDivElement} Filter
 * @property {(initial: boolean=false) => void} sync
 */

/**
 * @param {Config[]} config 配置列表
 * @param {Object[]} choices={} 选项值
 * @param {function(string, any, Object[]): void|string} onChange=null 回调
 * @param {boolean=false} showTitle
 * @param {boolean=true} fillPlaceholder
 * @return {Filter}
 */
export default function Filter({config, choices, onChange, showTitle, fillPlaceholder = true}) {
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
		if (isReactive(choices)) refreshHandlers.push(callback);
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
			if (warning?.isConnected) warning.innerText = text;
			else {
				warning = <div className='input-warning' aria-live='polite'>{text}</div>;
				row.append(warning);
			}
		}

		switch (type) {
			case 'element': {
				row = item.element;
			}
			break;
			case 'radio': {
				const required = !!item.required;
				const handler = ({target: btn}) => {
					let value = item.choices[btn.textContent];

					value = load(state[id]) === value ? undefined : value;
					if (value == null && required) return;

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

					if (value != null) {
						// 更新同组样式
						btn.classList.add('active');
						btn.setAttribute('aria-checked', 'true');
					}

					state[id] = save(value);
				};

				const initState = load(state[id]);
				row = <div className='choice-scroll' role='radiogroup' aria-label={name} onClick.children{'button'}={handler}>
					{Object.entries(item.choices).map(([label, value]) => {
						const active = initState === value;
							return <button className={active ? 'chip active' : 'chip'} _val={value}
										   type='button' role='radio' aria-checked={active}
										   title={title?.[label] || label}>{label}</button>;
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
					const value = item.choices[btn.textContent];

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
											title={title?.[label] || label}>{label}</button>);
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
				const {pattern: pat} = item;

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
							let error = pattern(val);
							if (typeof error !== 'string')
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
					let invalid = pattern && value && isInvalid(value);
					if (invalid) {
						if (doSubmit) {
							input.value = load(state[id]);
							invalid = false;
						}
					} else {
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

				addRefreshHandler(id, () => {input.value = load(state[id]) ?? '';});
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
					emit(id, newValue);
					state[id] = newValue;
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
					emit(id, newValue);
					state[id] = newValue;
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

				addRefreshHandler(id, () => {
					[r1.valueAsNumber, r2.valueAsNumber] = state[id];
					updateUI();
				});
			}
			break;
		}

		const isString = typeof id === "string";
		return (<div className="filter-row" data-id={isString ? id : undefined} _key={id}>
			{name && (!showTitle
				? <div className="filter-label" title={typeof title === "string" ? title : undefined}>{name}</div>
				: <>
					<div className="filter-label">{name}</div>
					{typeof title === "string" ? <div className="filter-label tooltip">{title}</div> : undefined}
				</>
			)}
			{row}
		</div>);
	};

	const div = <div className="filter">{config.map(itemRenderer)}</div>;
	div.sync = sync;
	return div;
};
