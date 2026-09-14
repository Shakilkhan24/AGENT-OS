const encoder = new TextEncoder();
/** UTF-8 byte length of a string, used by transport and queue budget checks. */
export const utf8Bytes = (text: string) => encoder.encode(text).byteLength;
