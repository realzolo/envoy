import type { MailDiagnostic, RetryDisposition } from "@/contracts/mail-diagnostics";
const reasons: Record<NonNullable<MailDiagnostic["reasonCode"]>, [string, string]> = {
 MAILBOX_NOT_FOUND:["收件邮箱不存在","请核对邮箱地址，修改后再按业务流程发送。"], DOMAIN_INVALID:["收件域无效或无法收信","请核对域名拼写并联系收件方确认收信配置。"], MAILBOX_DISABLED:["收件邮箱已停用","请联系收件方启用邮箱或提供其他地址。"], MAILBOX_FULL:["收件邮箱已满","请收件方清理容量后，再按业务流程发起新的发送。"], MESSAGE_TOO_LARGE:["邮件过大","请缩减正文或附件大小。"], CONTENT_REJECTED:["内容被收件方策略拒绝","请检查邮件内容并联系收件方确认允许的内容。"], ATTACHMENT_REJECTED:["附件被收件方策略拒绝","请检查附件类型和大小。"], RECIPIENT_SUPPRESSED:["收件地址已被抑制","请先核对抑制来源；诊断查询不会解除抑制。"], PROVIDER_QUOTA_EXCEEDED:["供应商发送配额不足","请检查发送配额和供应商账户。"], PROVIDER_RATE_LIMITED:["供应商限流","请查看当前重试责任和处理计划。"], PROVIDER_AUTH_FAILED:["供应商身份验证失败","请检查当前供应商凭据。"], PROVIDER_PERMISSION_DENIED:["供应商拒绝当前权限","请检查供应商账户权限。"], SENDER_NOT_VERIFIED:["发件身份未验证","请检查发件域与供应商验证状态。"], INVALID_RECIPIENT:["收件地址格式不符合要求","请核对收件地址。"], PROVIDER_REQUEST_INVALID:["供应商拒绝请求参数","请核对发送参数和供应商契约。"],
};
const classes: Record<MailDiagnostic["code"], [string,string]> = {
 MAILBOX_PERMANENTLY_REJECTED:["收件方永久拒绝","永久拒绝不能证明邮箱不存在，请核对收件方配置和地址。"], MAILBOX_TEMPORARILY_REJECTED:["因临时原因最终退信","本次投递已经结束，请联系收件方排查后再按业务流程发送。"], DELIVERY_DEFERRED:["投递延期","供应商仍在处理，请等待最终结果。"], DELIVERY_FAILED:["投递失败","请查看已记录的标准事实，核对收件方与供应商状态。"], RECIPIENT_SUPPRESSED:reasons.RECIPIENT_SUPPRESSED, PROVIDER_RATE_LIMITED:reasons.PROVIDER_RATE_LIMITED, PROVIDER_AUTHENTICATION_FAILED:reasons.PROVIDER_AUTH_FAILED, INVALID_RECIPIENT:reasons.INVALID_RECIPIENT,
 PROVIDER_POLICY_REJECTED:["供应商策略拒绝提交","请检查供应商发送政策、发件身份与收件限制。"],
 PROVIDER_REJECTED:["供应商拒绝本次提交","当前只确认了拒绝类别，请核对供应商账户与原邮件记录。"],
 PROVIDER_UNAVAILABLE:["供应商暂不可用","请检查供应商服务与账户状态，并按原请求的后续处理计划等待。"],
 PROVIDER_CONNECTION_UNAVAILABLE:["提交前无法连接供应商","请检查当前通道网络连接与供应商服务。"],
 SUBMISSION_GUARD_REJECTED:["提交条件未满足","请核对当前发件授权、通道与执行条件。"],
 INTERRUPTED_SUBMISSION:["邮件提交过程被中断","请先核对原提交，确认结果前不要重复发送。"],
 NO_ELIGIBLE_ROUTE:["没有可用发送通道","请核对当前 Service 的发件域授权和供应商发送身份。"],
 UNSUPPORTED_MESSAGE_CAPABILITY:["当前通道不支持邮件要求","请核对邮件格式、附件与当前通道能力。"],
 UNSUPPORTED_MAIL_FEATURE:["当前通道不支持该邮件功能","请核对当前邮件功能与供应商通道能力。"],
 ROUTE_TEMPORARILY_UNAVAILABLE:["发送通道暂不可用","请等待原请求的调度结果，并检查通道状态。"],
 LOCAL_PREPARATION_FAILED:["邮件发送准备失败","请核对附件、发件配置与原任务；当前未记录具体根因。"],
 PROVIDER_NOT_ACCEPTED:["供应商未受理本次提交","请查看原请求后续处理计划与当前授权条件。"],
 WORKFLOW_EXHAUSTED:["自动处理已停止","请检查原任务，再按业务流程处理。"],
 FILE_NOT_READY:["邮件附件尚未准备好","请核对附件处理状态，等待完成后按业务流程发送。"],
 FILE_UNAVAILABLE:["邮件附件不可用","请检查附件保留、安全检查与授权状态。"],
 VALIDATION_FAILED:["发送请求未通过校验","请核对发送字段；当前分类本身不能确定具体错误字段。"],
 UNCLASSIFIED_FAILURE:["发送失败原因尚未分类","现有记录不足以确认具体原因，请核对原邮件与通道状态。"],
 SEND_DEADLINE_EXCEEDED:["超过发送截止时间","不再发起新的供应商提交，已受理邮件仍可能继续处理。"], SUBMISSION_OUTCOME_UNKNOWN:["提交结果尚未确认","请先核对原提交结果，重新发送可能重复投递。"], RECONCILIATION_EXHAUSTED:["提交结果需要人工核对","自动核对已停止，请检查原尝试事实。"], SENDER_NOT_AUTHORIZED:["发件授权不可用","请检查当前Service和域授权。"], CONTENT_EXPIRED:["保存内容已过期","历史身份和投递事实仍保留。"],
};
export function diagnosticPresentation(value: MailDiagnostic) {
 const [title,advice] = (value.reasonCode && reasons[value.reasonCode]) || classes[value.code];
 const detail = value.detailAvailability === "SPECIFIC" ? "已取得明确的结构化原因。" : value.detailAvailability === "NOT_RECORDED" ? "历史记录未保存更具体原因。" : value.detailAvailability === "PROVIDER_NOT_SUPPLIED" ? "上游未提供可确认的具体原因。" : "当前只确认了原因类别，无法进一步确定具体原因。";
 return {title,advice,detail};
}
export function retryPresentation(value: RetryDisposition) {
 return value.owner === "PROVIDER" ? "供应商继续处理，等待最终回执" : value.action === "SCHEDULED" ? "Envoy 负责后续处理" : value.action === "MANUAL_REVIEW" ? "需要人工核对；不表示已授权重新发送" : "本次处理已停止";
}
