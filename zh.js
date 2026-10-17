/* 叮咚 — Simplified Chinese UI layer.
 * A dictionary translator for every user-visible string the app renders: text nodes, the title /
 * placeholder / aria-label / alt attributes, <option> labels and the document title. It watches the
 * DOM with a MutationObserver, so menus, modals, toasts and stats that appear later are translated
 * before they are painted. User content (messages, names, file names) is never touched.
 */
(() => {
  'use strict';
  document.documentElement.lang = 'zh-CN';

  // ---------------------------------------------------------------- exact strings
  const D = {
    // brand
    'Dischord': '叮咚', 'Welcome to Dischord': '欢迎来到叮咚', 'Welcome to 叮咚': '欢迎来到叮咚', 'Refresh 叮咚 to load screen-share controls.': '请刷新叮咚以加载屏幕共享控制。',
    'Servers, text channels and voice/video rooms. Fully peer-to-peer, powered by VDO.Ninja. No accounts, no backend.': '服务器、文字频道、语音视频房间一应俱全。全程点对点直连，基于 VDO.Ninja，无需注册账号，也没有后端服务器。',
    // shell / nav
    'Open servers and channels': '打开服务器和频道', 'Channels': '频道', 'Back to call': '返回通话', 'User settings': '用户设置',
    'Close navigation': '关闭导航', 'Direct messages': '私信', 'Direct Messages': '私信', 'Add a server': '添加服务器', 'Server options': '服务器选项',
    'Invite people': '邀请好友', 'Create text channel': '创建文字频道', 'Create voice channel': '创建语音频道', 'Rename server': '重命名服务器',
    'Leave server': '退出服务器', 'Voice Connected': '语音已连接', 'Time in this call': '本次通话时长', 'Disconnect': '断开连接',
    'Turn on camera': '开启摄像头', 'Turn off camera': '关闭摄像头', 'Video': '视频', 'Share your screen': '共享屏幕', 'Screen': '屏幕',
    'Online': '在线', 'Offline': '离线', 'Mute': '静音', 'Unmute': '取消静音', 'Input options': '输入选项', 'Deafen': '关闭声音', 'Undeafen': '开启声音',
    'Output options': '输出选项', 'Drag to resize': '拖动调整宽度', 'Search messages (Ctrl+F)': '搜索消息 (Ctrl+F)', 'Member list': '成员列表',
    'Create a server': '创建服务器', 'Join with invite link': '通过邀请链接加入', 'Attach files (sent only when downloaded)': '添加文件（对方点击下载时才传输）',
    'Mention someone': '提及成员', 'Emoji': '表情', 'Send message': '发送消息', 'Drop files to share on request': '拖放文件即可分享，对方下载时才传输',
    'Join Voice': '加入语音', 'Join with Camera': '开启摄像头加入', 'Done choosing devices': '设备选择完成', 'Camera options': '摄像头选项',
    'Flip camera': '翻转摄像头', 'Screen share options': '屏幕共享选项', 'Send a reaction': '发送表情', 'More reactions': '更多表情',
    'Voice & video settings': '语音和视频设置', 'Search messages': '搜索消息', 'Close search (Esc)': '关闭搜索 (Esc)', 'Hide members': '隐藏成员',
    'Show members': '显示成员', 'Close': '关闭', 'Stop sharing': '停止共享', 'Waiting for you to pick a screen… (click to cancel)': '等待选择共享画面…（点击取消）',
    'Voice connection': '语音连接',
    // channel list / members
    'Your servers': '你的服务器', 'No servers yet': '还没有服务器', 'Text channels': '文字频道', 'Voice channels': '语音频道', 'Create channel': '创建频道',
    'No conversations yet. Right-click someone in a server and choose': '还没有私信。在服务器中右键点击某人并选择', 'Message': '私信',
    'Call running for': '通话已进行', 'Voice & video, peer-to-peer': '语音和视频 · 点对点直连', '(you)': '（你）', 'Remove all offline people': '移除所有离线成员',
    'Waiting for others…': '等待其他人加入…', 'Members': '成员', 'online': '在线', 'offline': '离线',
    // stage
    'LIVE': '直播', "You're sharing your screen": '你正在共享屏幕', 'Watch stream': '观看直播', 'Stop watching': '停止观看', 'Stream quality': '直播画质',
    'Exit window fullscreen': '退出窗口全屏', 'Fill the window': '铺满窗口', 'Exit fullscreen': '退出全屏', 'Fullscreen': '全屏',
    "Auto (sender's setting)": '自动（跟随发送方）', 'No one is here yet. Jump in and others will see you in the channel list.': '这里还没有人。加入后，其他人会在频道列表中看到你。',
    // context menus
    'Input device': '输入设备', 'Output device': '输出设备', 'Camera': '摄像头', 'No microphone found.': '未找到麦克风。',
    'This browser does not list output devices.': '此浏览器不提供输出设备列表。', 'No camera found.': '未找到摄像头。',
    'Join a voice channel and allow camera access to see device names.': '加入语音频道并允许使用摄像头后可显示设备名称。',
    'Join a voice channel and allow microphone access to see device names.': '加入语音频道并允许使用麦克风后可显示设备名称。',
    'Input volume': '输入音量', 'Noise suppression': '降噪', 'Output volume': '输出音量', 'Camera on': '开启摄像头', 'Resolution': '分辨率',
    'Frame rate': '帧率', 'Bitrate': '码率', 'Optimize for': '优化目标', 'Smoothness': '流畅优先', 'Clarity': '清晰优先', 'Screen share': '屏幕共享',
    'Join a voice channel to share your screen.': '加入语音频道后即可共享屏幕。', 'Share computer sound': '共享电脑声音',
    'The voices of this call are filtered out of the shared sound (needs a recent Chrome or Edge).': '共享的声音会自动滤除本通话中的人声（需要较新版本的 Chrome 或 Edge）。',
    'Off: only a shared browser tab keeps its own sound.': '关闭时：只有共享浏览器标签页会保留其声音。',
    'Picture settings apply to your current share. Sound applies the next time you share.': '画面设置会立即应用到当前共享；声音设置在下次共享时生效。',
    'Mark as read': '标记为已读', 'Close conversation': '关闭对话', 'Join voice': '加入语音', 'Join with camera': '开启摄像头加入',
    'Rename channel': '重命名频道', 'Delete channel': '删除频道', 'Mark server as read': '全部标记为已读', 'Copy invite link': '复制邀请链接',
    'Mute microphone': '麦克风静音', 'Microphone volume': '麦克风音量', 'Share screen': '共享屏幕', 'My preview': '我的预览', 'Full quality': '原画质',
    'Low': '低', 'Hidden': '隐藏', 'Show stream stats': '显示视频数据', 'Connection diagnostics': '连接诊断', 'Edit profile': '编辑个人资料',
    'User volume': '用户音量', 'Stream volume': '直播音量', 'Hide video': '隐藏视频', 'Video quality': '视频画质', 'Focus stream': '聚焦直播',
    'Fullscreen stream': '全屏观看直播', 'Mention': '提及', 'Copy username': '复制用户名', 'Remove from server': '从服务器移除', 'Kick from voice': '移出语音',
    'Add reaction': '添加回应', 'Reply': '回复', 'Copy text': '复制文字', 'Open image': '打开图片', 'Copy image': '复制图片', 'Download image': '下载图片',
    'Save preview': '保存预览', 'Edit message': '编辑消息', 'Delete message': '删除消息', 'Auto': '自动',
    // messages
    'Replying to': '回复', 'Cancel reply': '取消回复', 'Image': '图片', 'Original message deleted': '原消息已删除', 'Jump to original message': '跳转到原消息',
    'Edit': '编辑', 'Delete': '删除', 'Message actions': '消息操作', '(edited)': '（已编辑）', 'Open image preview': '打开图片预览', 'Shared image': '分享的图片',
    'Loading image preview…': '正在加载图片预览…', 'Image preview unavailable.': '图片预览不可用。', 'Preparing image preview…': '正在生成图片预览…',
    'Preview unavailable. Someone with it must be online.': '预览暂不可用，需要有此图片的成员在线。',
    'Preview unavailable. You can download the original image.': '预览不可用，可以下载原图。', 'Remove': '移除',
    'Images show previews automatically.': '图片会自动显示预览。', 'Files are shared on Download. Keep this tab open.': '文件在对方点击下载时才传输，请保持此页面打开。',
    'Download': '下载', 'Cancel download': '取消下载', 'Saving…': '保存中…', 'Retry download': '重新下载', 'Saved': '已保存', 'Open': '打开', 'Play': '播放',
    'Choose where to save this image…': '选择图片保存位置…', 'Saving image…': '正在保存图片…', 'Original unavailable after reload.': '页面刷新后原图已不可用。',
    'Choose where to save this file…': '选择文件保存位置…', 'Choose where to save this file.': '选择文件保存位置。', 'Saving file…': '正在保存文件…',
    'Unavailable after reload. Attach it again.': '页面刷新后不可用，请重新添加。', 'Unknown size': '未知大小',
    'Loading…': '加载中…', 'Seek': '进度', 'Previous': '上一个', 'Play / pause (Space)': '播放/暂停（空格）', 'Next': '下一个', 'Mute (M)': '静音 (M)',
    'Volume': '音量', 'Speed (< >)': '速度 (< >)', 'Playback speed': '播放速度', 'Repeat': '循环播放', 'Picture in picture': '画中画', 'Fullscreen (F)': '全屏 (F)',
    'Save to device': '保存到设备', 'This file could not be read.': '无法读取该文件。',
    "This file's format can't be played here. Save it to your device to open it in another player.": '此处无法播放该文件格式，请保存到设备后用其他播放器打开。',
    // search
    'Searches the message history saved on this device. Type': '搜索本设备上保存的聊天记录。输入', "to see one person's messages.": '可只看某个人的消息。',
    'No messages match.': '没有匹配的消息。', 'All direct messages': '全部私信', 'Everywhere': '全部',
    // modals
    'Pick a name and a colour. It\'s stored only in this browser.': '设置你的昵称和颜色，仅保存在此浏览器中。', 'Continue': '继续', 'Your name': '你的昵称',
    'Display name': '昵称', 'e.g. daniel': '例如：小明', 'Profile colour': '主题颜色', 'Custom colour': '自定义颜色',
    'My profile': '个人资料', 'Voice & Video': '语音和视频', 'Settings sections': '设置分类', 'Notifications': '通知', 'Enable desktop notifications': '开启桌面通知',
    'Microphone': '麦克风', 'Microphone volume ·': '麦克风音量 ·',
    '100% is the normal level. Boost a quiet microphone up to 200%; lower it if your voice sounds distorted.': '100% 为正常音量。麦克风声音太小可提高到 200%；声音失真时请调低。',
    'Optimize screen share for': '屏幕共享优化', 'Smoothness: prioritize frame rate (recommended)': '流畅优先：优先保证帧率（推荐）',
    'Clarity: prioritize sharp text and detail': '清晰优先：优先保证文字与细节',
    'Smoothness prioritizes the selected FPS under load. 1080p and a Low own preview reduce the processing needed for steady motion. Clarity may reduce FPS to keep text sharp.': '流畅优先会在负载较高时优先保证所选帧率；选择 1080p 并把自我预览设为“低”可减轻处理压力。清晰优先可能降低帧率以保证文字清晰。',
    'Watching others': '观看他人', 'Video codec': '视频编码', 'H.264 (recommended)': 'H.264（推荐）', 'Your own preview': '自我预览', 'Low (saves CPU)': '低（节省 CPU）',
    'Max download per stream': '单路最大下载码率', "No limit (use each sender's setting)": '不限制（跟随发送方设置）',
    'Always show stream stats (resolution · fps · bitrate · codec) on video tiles': '在视频画面上始终显示数据（分辨率 · 帧率 · 码率 · 编码）',
    "Higher bitrate improves detail, and every viewer needs that much upload bandwidth. Change any stream's quality from its tile.": '码率越高画面越细腻，但每位观众都需要相应的上传带宽。可在每路画面上单独调整画质。',
    "Higher bitrate improves detail, and every viewer needs that much upload bandwidth. Change any stream's quality from its tile. Camera changes reconnect your call. Screen share changes apply to your current share.": '码率越高画面越细腻，但每位观众都需要相应的上传带宽。可在每路画面上单独调整画质。摄像头设置会重新连接通话；屏幕共享设置会立即应用到当前共享。',
    'Choose camera…': '选择摄像头…',
    'Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.': '点击麦克风和耳机按钮旁的小箭头，可选择输入和输出设备。',
    'Join a voice channel to pick your camera. Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.': '加入语音频道后可选择摄像头。点击麦克风和耳机按钮旁的小箭头，可选择输入和输出设备。',
    'Cancel': '取消', 'Save': '保存', 'Create': '创建', 'Have an invite?': '已有邀请？', 'Server name': '服务器名称',
    'Your server is a private peer-to-peer space. Share the invite link with friends.': '服务器是一个私密的点对点空间，把邀请链接发给好友就能一起玩。',
    'Join a server': '加入服务器', 'Type a join code, or paste an invite link.': '输入加入码，或粘贴邀请链接。', 'Join code or invite link': '加入码或邀请链接', 'Join': '加入',
    'Anyone with this link can join, chat and hop into voice. Keep it private.': '拿到此链接的人都可以加入、聊天和语音，请妥善保管。',
    'Invite link': '邀请链接', 'Join code': '加入码', 'Copy code': '复制加入码', 'Turn off': '关闭',
    'A short code friends can type instead of the link. It lasts 7 days and works while someone from this server is online.': '好友可以输入简短的加入码代替链接。有效期 7 天，服务器内有人在线时可用。',
    'Create code': '生成加入码', 'Done': '完成', 'Copy link': '复制链接', 'Channel type': '频道类型', 'Text': '文字', 'Voice': '语音', 'Channel name': '频道名称',
    'new-channel': '新频道', 'Remove offline people': '移除离线成员',
    'You can rejoin later with an invite link. Your local message history for this server will be removed.': '之后可以通过邀请链接重新加入。此服务器在本机的聊天记录将被删除。',
    // diagnostics
    'How your traffic reaches each person: straight to them, or relayed through a TURN server when no direct path could be found.': '你的数据如何到达每个人：直接连接，或在无法直连时通过 TURN 服务器中继。',
    'Keep recording when this is closed': '关闭窗口后继续记录', 'Reset totals': '重置统计', 'Copy report': '复制报告', 'Direct · local network': '直连 · 局域网',
    'Direct · internet (STUN)': '直连 · 互联网 (STUN)', 'Relayed · via TURN': '中继 · 经由 TURN', 'Relayed': '中继', 'Direct': '直连', 'no data yet': '暂无数据',
    'This device': '本设备', 'Chat & files': '聊天和文件', 'Camera video': '摄像头视频', 'Screen video': '屏幕视频', 'My screen share': '我的屏幕共享',
    'Join a server to see connections.': '加入服务器后可查看连接。', 'No one else is connected right now. Connections appear here as people come online.': '目前没有其他人连接。有人上线后会显示在这里。',
    'Not identified (someone on an older version)': '未识别（对方使用旧版本）', '↑ to them': '↑ 发给对方', '↓ from them': '↓ 来自对方',
    'Your own previews, and the link between your call and your screen share. It never leaves this device, so it is left out of the totals.': '你自己的预览，以及通话与屏幕共享之间的连接。它不会离开本设备，因此不计入统计。',
    // toasts
    'Invite link copied': '邀请链接已复制', 'Join code copied': '加入码已复制', 'Copied': '已复制', 'Image copied': '图片已复制', 'Report copied': '报告已复制',
    'Screen share settings updated.': '屏幕共享设置已更新。', 'Screen share restarted with the same source.': '已使用同一画面源重新开始共享。',
    'This browser needs you to choose the source again for that setting. Your current share is still running.': '此设置需要重新选择共享画面，当前共享仍在继续。',
    'This phone could not apply that setting. Your current share is still running.': '此手机无法应用该设置，当前共享仍在继续。',
    'This setting could not be applied. Your current share is still running.': '无法应用此设置，当前共享仍在继续。',
    'The shared source is no longer available.': '共享的画面源已不可用。',
    'The screen-share update did not finish. Your current share has been kept.': '屏幕共享设置未能完成更新，已保留当前共享。',
    'Could not reach the active screen share.': '无法连接到当前的屏幕共享。',
    'Screen sharing is unavailable in this browser. You can still watch shared screens and use your camera.': '此浏览器不支持屏幕共享，你仍然可以观看他人的共享和使用摄像头。',
    'Turn your camera on first.': '请先开启摄像头。', 'This device has only one camera.': '此设备只有一个摄像头。',
    'The camera is not running yet. Try again in a moment.': '摄像头尚未启动，请稍后再试。', 'Could not switch camera.': '无法切换摄像头。',
    'Back camera': '后置摄像头', 'Front camera': '前置摄像头', 'Looking for that server…': '正在查找该服务器…',
    'No server answered that code. It may be mistyped or expired, or nobody from the server is online right now.': '没有服务器响应这个加入码。可能输入有误、已过期，或该服务器当前无人在线。',
    'Message is too long (4000 characters max).': '消息过长（最多 4000 字）。',
    'Too many available files in this tab. Delete an older file message, then send again.': '此页面中可供下载的文件过多。请删除一条较早的文件消息后再发送。',
    'That file can no longer be read. Download it again.': '无法再读取该文件，请重新下载。', 'Picture in picture is not available here.': '此处不支持画中画。',
    'Up to 4 files per message.': '每条消息最多 4 个文件。', 'Could not attach that file. Its name or size is invalid.': '无法添加该文件：文件名或大小无效。',
    'Image is still loading. Try again in a moment.': '图片仍在加载，请稍后再试。', 'Could not save that image.': '无法保存该图片。',
    'Could not copy the image. Your browser may not allow it.': '无法复制图片，浏览器可能不允许。', "That invite link doesn't look right.": '邀请链接格式不正确。',
    'Open a text channel to mention someone.': '请先打开一个文字频道再提及成员。', 'Original message is no longer in local history.': '原消息已不在本地记录中。',
    'Could not copy the report here.': '无法在此复制报告。', 'A newer version of 叮咚 is available. Reload the page to update.': '叮咚有新版本可用，刷新页面即可更新。',
    'Update the Windows app to restart sharing with the same source automatically.': '请更新 Windows 客户端，以便自动使用同一画面源重新共享。',
    // file transfer
    'File transfer timed out. Try Download again.': '文件传输超时，请重新下载。', 'Download timed out. The sender may have disconnected.': '下载超时，发送方可能已断开。',
    'The sender could not read this file.': '发送方无法读取该文件。', 'This file is no longer available or the sender disconnected.': '该文件已不可用，或发送方已断开。',
    'Unable to contact the sender.': '无法联系发送方。', 'Download interrupted. Try Download again.': '下载中断，请重新下载。', 'File transfer failed.': '文件传输失败。',
    'This file was removed or the sender disconnected.': '该文件已被移除，或发送方已断开。', 'The browser could not write or save this file.': '浏览器无法写入或保存该文件。',
    'File saved to your chosen location.': '文件已保存到所选位置。', 'The browser could not save this file.': '浏览器无法保存该文件。', 'Download cancelled.': '下载已取消。',
    'The browser could not open this destination.': '浏览器无法打开该保存位置。', 'This file is no longer available.': '该文件已不可用。',
    'This file is no longer available. Select and send it again.': '该文件已不可用，请重新选择并发送。', 'Another download is in progress. Finish or cancel it first.': '另一个下载正在进行，请先完成或取消。',
    'The sender is offline. They need to keep this tab open.': '发送方已离线，需要对方保持页面打开。', 'Unable to start this download.': '无法开始下载。',
    'File unavailable. The sender needs to keep the original tab open.': '文件不可用，发送方需要保持原页面打开。', 'The sender is busy. Try Download again shortly.': '发送方正忙，请稍后重新下载。',
    'File transfer was interrupted. Try Download again.': '文件传输中断，请重新下载。', 'The sender cancelled this transfer.': '发送方取消了此次传输。',
    'Disconnected from the server.': '已与服务器断开。', 'The sender disconnected.': '发送方已断开。', 'Download stopped.': '下载已停止。',
    'This attachment is not an image.': '该附件不是图片。', 'This image format cannot be previewed by your browser.': '浏览器无法预览此图片格式。',
    'This image has invalid dimensions.': '图片尺寸无效。', 'This browser cannot create image previews.': '此浏览器无法生成图片预览。',
    'This browser could not encode the image preview.': '此浏览器无法编码图片预览。', 'This browser could not create a bounded image preview.': '此浏览器无法生成图片预览。',
  };
  // <option> labels (settings and menus)
  const OPT = {
    'Source (native)': '原生分辨率', '5 fps': '5 帧', '5 fps (slides)': '5 帧（幻灯片）', '15 fps': '15 帧', '30 fps': '30 帧', '60 fps': '60 帧', '60 fps (games)': '60 帧（游戏）',
    'Auto': '自动', 'VP9': 'VP9', 'AV1': 'AV1', 'Smoothness': '流畅优先', 'Clarity': '清晰优先', 'Full quality': '原画质', 'Low': '低', 'Hidden': '隐藏',
  };
  // attribute-specific wording where it differs from the visible label
  const ATTR = { 'Message': '发送消息', 'Mute': '静音', 'Remove': '移除' };

  // ---------------------------------------------------------------- patterns (whole string)
  const R = [
    [/^Message #(.+)$/, '在 #$1 中发消息'], [/^Message @(.+)$/, '发消息给 @$1'],
    [/^Welcome to #(.+)!$/, '欢迎来到 #$1！'],
    [/^This is the start of the #(.+) channel\. Messages travel peer-to-peer; people who join later get recent history from whoever is online\.$/, '这里是 #$1 频道的开端。消息点对点传输，后来加入的人会从在线成员那里同步最近的聊天记录。'],
    [/^This is the start of your direct messages with (.+)\. They go straight from your device to theirs; messages sent while one of you is offline arrive the next time you are both online\.$/, '这是你与 $1 私信的开端。消息直接从你的设备发送到对方设备；一方离线时发送的消息会在双方都在线时送达。'],
    [/^(Online|Offline) · only the two of you can see this$/, (m, a) => (a === 'Online' ? '在线' : '离线') + ' · 仅你们两人可见'],
    [/^Today at (.+)$/, '今天 $1'], [/^Yesterday at (.+)$/, '昨天 $1'],
    [/^(.+) \(you\)'s screen$/, '$1（你）的屏幕'], [/^(.+)'s screen$/, '$1 的屏幕'], [/^(.+) \(you\)$/, '$1（你）'],
    [/^(.+) is sharing their screen$/, '$1 正在共享屏幕'],
    [/^(.+)'s server$/, '$1的服务器'],
    [/^is typing…$/, '正在输入…'], [/^are typing…$/, '正在输入…'],
    [/^Online — (\d+)$/, '在线 — $1'], [/^Offline — (\d+)$/, '离线 — $1'],
    [/^(\d+) others? online$/, '另有 $1 人在线'],
    [/^Auto · (.+)$/, '自动 · $1'], [/^Auto$/, '自动'], [/^Up to (.+)$/, '最高 $1'],
    [/^No ping reply from (.+) yet$/, '尚未收到 $1 的延迟响应'], [/^Ping to (.+): (\d+) ms$/, '到 $1 的延迟：$2 ms'],
    [/^Loading image… (\d+)%$/, '图片加载中… $1%'], [/^Downloading (\d+)%$/, '下载中 $1%'],
    [/^(.+) · saved · click to play$/, '$1 · 已保存 · 点击播放'], [/^(.+) · saved · click to open$/, '$1 · 已保存 · 点击打开'],
    [/^(.+) · you choose a save location when downloading$/, '$1 · 下载时可选择保存位置'],
    [/^(.+) · large file: uses browser memory here$/, '$1 · 大文件：将占用浏览器内存'],
    [/^(Download|Cancel download|Saving…|Retry download): (.+)$/, (m, l, n) => ({ 'Download': '下载', 'Cancel download': '取消下载', 'Saving…': '保存中…', 'Retry download': '重新下载' })[l] + '：' + n],
    [/^(.+) is offline\. They will get this when you are both online\.$/, '$1 当前离线，双方都在线时对方会收到这条消息。'],
    [/^Open (.+)$/, '打开 $1'], [/^Download (.+)$/, '下载 $1'], [/^Resumed at (.+)$/, '从 $1 继续播放'],
    [/^Invite friends to (.+)$/, '邀请好友加入 $1'], [/^Joined (.+)$/, '已加入 $1'], [/^Leave '(.+)'$/, '退出「$1」'],
    [/^Delete (#?)(.+) for everyone\?$/, '要为所有人删除 $1$2 吗？'], [/^Mention (.+)$/, '提及 $1'], [/^Removed (\d+) (person|people)$/, '已移除 $1 人'],
    [/^Removed (.+)$/, '已移除 $1'], [/^Removing (.+) from the call$/, '正在将 $1 移出通话'], [/^Moving (.+) to (.+)$/, '正在将 $1 移到 $2'],
    [/^(.+)'s app did not respond\. They may need to reload the page\.$/, '$1 的应用没有响应，对方可能需要刷新页面。'],
    [/^(.+) is on an older version of 叮咚 and can't (.+) until they reload the page\.$/, '$1 使用的是旧版叮咚，刷新页面前无法执行该操作。'],
    [/^Remove (\d+) offline (person|people) from the member list\? Their messages stay, and anyone who comes back online is listed again\.$/, '要从成员列表中移除 $1 位离线成员吗？他们的消息会保留，重新上线后会再次显示。'],
    [/^Microphone: (.+)$/, '麦克风：$1'], [/^Output: (.+)$/, '输出：$1'], [/^Camera: (.+)$/, '摄像头：$1'], [/^Notifications: (.+)$/, '通知：$1'],
    [/^Expires (.+)\. Works while someone from this server is online\.$/, '$1 过期。服务器内有人在线时可用。'],
    [/^(\d+) results?( · showing the newest 100)?$/, (m, n, more) => `${n} 条结果${more ? ' · 仅显示最新 100 条' : ''}`],
    [/^Your (screen share|camera) is being throttled: this PC can't encode it fast enough \((.+)\)\. Try a lower resolution, the H\.264 codec, or a Low \/ Hidden own preview\.$/,
      (m, w) => `你的${w === 'camera' ? '摄像头' : '屏幕共享'}画质被降低：这台电脑编码速度不足。请尝试更低的分辨率、H.264 编码，或把自我预览设为“低”/“隐藏”。`],
    [/^Your (screen share|camera) is being throttled: your upload can't carry the bitrate(?: \(about (.+) available\))?\. Pick a bitrate below that for a steady stream\.$/,
      (m, w, up) => `你的${w === 'camera' ? '摄像头' : '屏幕共享'}画质被降低：上传带宽不足${up ? `（约 ${up} 可用）` : ''}。请选择更低的码率以保持稳定。`],
    [/^Share of connection time since (.+)\. (\d+) live connections? now, (\d+) relayed\.$/, '自 $1 起的连接时长占比。当前 $2 个连接，其中 $3 个经中继。'],
    [/^(\d+) local$/, '$1 个本地连接'], [/^changed (\d+)×$/, '切换 $1 次'],
  ];
  // substring rules for the live stats overlay
  const STAT = [
    [/sending: /g, '发送：'], [/CPU-limited/g, 'CPU 受限'], [/uplink-limited/g, '上行受限'], [/(\d+) encodes?/g, '$1 路编码'],
    [/\bhardware\b/g, '硬件编码'], [/\bsoftware\b/g, '软件编码'], [/\buplink /g, '上行 '], [/% loss/g, '% 丢包'], [/\brelayed\b/g, '中继'],
  ];
  const SKIP = '.msg .text, .mf-name, .reply-excerpt, .msg-reply span, .author, .vu-name, .me-name, #serverName, #chanName, #mobileServerName, .vw-text, #msgMirror, .sr-text, .mm-name, script, style, textarea';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  function tr(text, kind) {
    const core = text.trim();
    if (!core || !/[A-Za-z]/.test(core)) return null;
    let out = null;
    if (kind === 'option' && Object.prototype.hasOwnProperty.call(OPT, core)) out = OPT[core];
    else if (kind === 'attr' && Object.prototype.hasOwnProperty.call(ATTR, core)) out = ATTR[core];
    else if (Object.prototype.hasOwnProperty.call(D, core)) out = D[core];
    else {
      for (const [re, rep] of R) if (re.test(core)) { out = core.replace(re, rep); break; }
      if (out !== null && out !== core) {
        // a pattern may wrap translatable parts, e.g. "Auto · 6 Mbps"
      }
    }
    if (out === null || out === core) return null;
    const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
    return lead + out + tail;
  }

  function fixText(node) {
    const p = node.parentElement;
    if (!p) return;
    if (p.closest('.tile-stats')) {
      let s = node.data, o = s;
      for (const [re, rep] of STAT) s = s.replace(re, rep);
      if (s !== o) node.data = s;
      return;
    }
    if (p.closest(SKIP)) return;
    const kind = p.tagName === 'OPTION' ? 'option' : 'text';
    // typing indicator: "<b>names</b> is typing…"
    const t = tr(node.data, kind);
    if (t !== null && t !== node.data) node.data = t;
  }
  function fixAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      let t = tr(v, 'attr');
      if (t === null && a === 'title' && /\bYou\b/.test(v) && el.classList.contains('re-pill')) t = v.replace(/\bYou\b/g, '你').replace(/\bsomeone\b/g, '某人');
      if (t !== null && t !== v) el.setAttribute(a, t);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1) return;
    fixAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) fixText(n); else fixAttrs(n); }
  }
  const fixTitle = () => { const t = document.title; const z = t.replace(/Dischord/g, '叮咚'); if (z !== t) document.title = z; };

  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
    fixTitle();
  });
  const startObs = () => {
    walk(document.documentElement);
    fixTitle();
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.documentElement) startObs();
  // toLocale* formatting follows the page language
  window.__zhLeftovers = () => {
    // dev helper: list visible English left on screen (technical terms allowed)
    const ok = /^(fps|Mbps|kbps|H\.?264|H264|VP8|VP9|AV1|4K|\d+p|ms|GB|MB|KB|CPU|TURN|STUN|UDP|TCP|Esc|Ctrl\+F|VDO\.Ninja|LIVE|Chrome|Edge|Windows|Android|WebP|ID)$/i;
    const out = new Set();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,.hidden,[hidden]') || !p.getClientRects().length) continue;
      const cs = getComputedStyle(p); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const words = (n.data.match(/[A-Za-z][A-Za-z.+']+/g) || []).filter((w) => !ok.test(w));
      if (words.length) out.add(n.data.trim().slice(0, 120));
    }
    document.querySelectorAll('[title],[placeholder],[aria-label]').forEach((el) => {
      if (!el.getClientRects().length || el.tagName === 'IFRAME' || el.closest('[aria-hidden="true"]')) return;
      for (const a of ATTRS) { const v = el.getAttribute(a); if (v && (v.match(/[A-Za-z][A-Za-z.+']+/g) || []).some((w) => !ok.test(w))) out.add('@' + a + ': ' + v.slice(0, 100)); }
    });
    return [...out];
  };
})();
