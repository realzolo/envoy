type SnsTopic = {
  partition: "aws" | "aws-us-gov" | "aws-cn";
  region: string;
};

const topicArnPattern = /^arn:(aws|aws-us-gov|aws-cn):sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/;

function snsTopic(value: string): SnsTopic | null {
  const match = topicArnPattern.exec(value);
  if (!match) return null;
  return { partition: match[1] as SnsTopic["partition"], region: match[2] };
}

function snsHostname(topic: SnsTopic) {
  return `sns.${topic.region}.${topic.partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com"}`;
}

function snsUrl(value: string, expectedTopicArn: string) {
  const topic = snsTopic(expectedTopicArn);
  if (!topic) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== snsHostname(topic)
      || url.port
      || url.username
      || url.password
      || url.hash
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function isTrustedSnsSigningCertificateUrl(value: string, expectedTopicArn: string) {
  const url = snsUrl(value, expectedTopicArn);
  return Boolean(
    url
    && !url.search
    && /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname)
  );
}

export function isTrustedSnsSubscribeUrl(value: string, expectedTopicArn: string) {
  const url = snsUrl(value, expectedTopicArn);
  return Boolean(
    url
    && url.pathname === "/"
    && url.searchParams.get("Action") === "ConfirmSubscription"
    && url.searchParams.get("TopicArn") === expectedTopicArn
    && url.searchParams.get("Token")
  );
}

export function snsSignatureAlgorithm(value: unknown) {
  if (value === "1") return "RSA-SHA1" as const;
  if (value === "2") return "RSA-SHA256" as const;
  return null;
}
