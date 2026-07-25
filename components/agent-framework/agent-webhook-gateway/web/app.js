const elements = {
	form: document.querySelector("#command-form"),
	input: document.querySelector("#command-input"),
	submit: document.querySelector("#submit-command"),
	stop: document.querySelector("#stop-command"),
	gatewayDot: document.querySelector("#gateway-dot"),
	gatewayStatus: document.querySelector("#gateway-status"),
	mapFrame: document.querySelector("#map-frame"),
	mapPlaceholder: document.querySelector("#map-placeholder"),
	mapStatus: document.querySelector("#map-status"),
	reloadMap: document.querySelector("#reload-map"),
	taskState: document.querySelector("#task-state"),
	taskText: document.querySelector("#task-text"),
	instructionId: document.querySelector("#instruction-id"),
	taskId: document.querySelector("#task-id"),
	taskDestination: document.querySelector("#task-destination"),
	reply: document.querySelector("#agent-reply"),
};

const LAST_INSTRUCTION_KEY = "dimos.agent-console.last-instruction";
let activeInstructionId = localStorage.getItem(LAST_INSTRUCTION_KEY);
let pollTimer;
let mapUrl;

async function requestJson(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: {
			"content-type": "application/json",
			...(options.headers ?? {}),
		},
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
	}
	return body;
}

function setGatewayState(connected, text) {
	elements.gatewayDot.classList.toggle("is-online", connected);
	elements.gatewayStatus.textContent = text;
}

function humanState(view) {
	const state = view.task?.state ?? view.status;
	const labels = {
		pending: "排队中",
		processing: "Agent 分析中",
		compiled: "任务已编译",
		submitted: "任务已提交",
		monitoring: "执行中",
		queued: "等待执行",
		resolving: "解析地点",
		exploring: "探索中",
		navigating: "导航中",
		recovering: "恢复路线",
		verifying: "确认目标",
		following: "跟随中",
		paused: "已暂停",
		completed: "已完成",
		failed: "未完成",
		cancelled: "已取消",
	};
	if (view.task?.state && labels[view.task.state]) {
		return labels[view.task.state];
	}
	if (view.reply) {
		return replyIndicatesFailure(view.reply.text) ? "未执行" : "已完成";
	}
	return labels[state] ?? state ?? "处理中";
}

function replyIndicatesFailure(text) {
	return /^(?:暂时无法|未执行：|控制链未连接：|控制链响应超时：|控制链协议异常：|机器人运动未启用：|DimOS Runtime 拒绝)/u.test(
		text,
	);
}

function renderInstruction(view) {
	const state = humanState(view);
	elements.taskState.textContent = state;
	elements.taskState.dataset.state =
		view.reply && replyIndicatesFailure(view.reply.text) ? "failed" : (view.task?.state ?? view.status);
	elements.taskText.textContent = view.text;
	elements.instructionId.textContent = view.instruction_id;
	elements.taskId.textContent = view.task?.task_id ?? "—";
	elements.taskDestination.textContent = view.task?.destination ?? "—";
	elements.reply.textContent = view.reply?.text ?? "Agent 已受理，等待真实任务状态。";
	const terminal = Boolean(view.reply);
	elements.submit.disabled = !terminal && view.status === "processing";
	return terminal;
}

async function pollInstruction() {
	if (!activeInstructionId) {
		return;
	}
	try {
		const view = await requestJson(`/v1/instructions/${encodeURIComponent(activeInstructionId)}`);
		setGatewayState(true, "Agent Gateway 已连接");
		if (renderInstruction(view)) {
			clearInterval(pollTimer);
			pollTimer = undefined;
			elements.submit.disabled = false;
		}
	} catch (error) {
		setGatewayState(false, `Gateway 不可用：${error.message}`);
	}
}

function startPolling(instructionId) {
	activeInstructionId = instructionId;
	localStorage.setItem(LAST_INSTRUCTION_KEY, instructionId);
	clearInterval(pollTimer);
	void pollInstruction();
	pollTimer = setInterval(() => void pollInstruction(), 750);
}

async function submitInstruction(text) {
	const instructionId = `console-${crypto.randomUUID()}`;
	elements.submit.disabled = true;
	elements.taskState.textContent = "正在受理";
	elements.taskState.dataset.state = "pending";
	elements.taskText.textContent = text;
	elements.instructionId.textContent = instructionId;
	elements.taskId.textContent = "—";
	elements.taskDestination.textContent = "—";
	elements.reply.textContent = "正在交给现有 Agent 分析。";
	try {
		await requestJson("/v1/instructions", {
			method: "POST",
			body: JSON.stringify({
				instruction_id: instructionId,
				text,
			}),
		});
		setGatewayState(true, "Agent Gateway 已连接");
		startPolling(instructionId);
		return true;
	} catch (error) {
		elements.submit.disabled = false;
		elements.taskState.textContent = "提交失败";
		elements.taskState.dataset.state = "failed";
		elements.reply.textContent = `指令没有进入 Agent：${error.message}`;
		setGatewayState(false, "Agent Gateway 连接失败");
		return false;
	}
}

elements.form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const text = elements.input.value.trim();
	if (!text) {
		return;
	}
	if (await submitInstruction(text)) {
		elements.input.value = "";
	}
});

elements.input.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
		event.preventDefault();
		elements.form.requestSubmit();
	}
});

elements.stop.addEventListener("click", () => {
	void submitInstruction("停");
});

async function checkMap() {
	if (!mapUrl) {
		return;
	}
	elements.mapStatus.textContent = "正在连接官方地图";
	try {
		await fetch(mapUrl, { cache: "no-store", mode: "no-cors" });
		elements.mapPlaceholder.classList.add("is-hidden");
	} catch {
		elements.mapPlaceholder.classList.remove("is-hidden");
		elements.mapStatus.textContent = "DimOS 地图服务尚未运行";
	}
}

function loadMap() {
	if (!mapUrl) {
		return;
	}
	elements.mapFrame.src = mapUrl;
	void checkMap();
}

elements.reloadMap.addEventListener("click", loadMap);

async function initialize() {
	try {
		const config = await requestJson("/v1/ui-config");
		mapUrl = config.map_url;
		loadMap();
		setInterval(() => void checkMap(), 3_000);
		setGatewayState(true, "Agent Gateway 已连接");
		if (activeInstructionId) {
			startPolling(activeInstructionId);
		}
	} catch (error) {
		setGatewayState(false, `Gateway 不可用：${error.message}`);
	}
}

void initialize();
