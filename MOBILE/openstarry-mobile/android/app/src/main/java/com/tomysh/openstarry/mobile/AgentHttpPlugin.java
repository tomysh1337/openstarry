package com.tomysh.openstarry.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Streams provider responses without buffering the entire reply in CapacitorHttp. */
@CapacitorPlugin(name = "AgentHttp")
public class AgentHttpPlugin extends Plugin {
    private static class Request {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        void cancel() {
            cancelled = true;
            if (connection != null) connection.disconnect();
        }
    }
    private final Map<String, Request> requests = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newFixedThreadPool(3);

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.length() > 100) { call.reject("请求标识无效"); return; }
        Request task = new Request();
        if (requests.putIfAbsent(id, task) != null) { call.reject("请求标识已使用"); return; }
        executor.execute(() -> {
            try {
                URL url = new URL(call.getString("url", ""));
                if (!(url.getProtocol().equals("https") || url.getProtocol().equals("http")) || url.getUserInfo() != null) throw new Exception("请求地址格式错误");
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                task.connection = connection;
                if (task.cancelled) throw new Exception("请求已停止");
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(180000);
                // Redirecting credentialed requests could send keys to a different host.
                connection.setInstanceFollowRedirects(false);
                connection.setRequestMethod(call.getString("method", "POST"));
                JSObject headers = call.getObject("headers", new JSObject());
                for (Iterator<String> names = headers.keys(); names.hasNext();) {
                    String name = names.next();
                    connection.setRequestProperty(name, headers.getString(name));
                }
                String body = call.getString("body");
                if (body != null) {
                    connection.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                String type = connection.getContentType();
                boolean streamed = status >= 200 && status < 300 && type != null && type.toLowerCase(Locale.ROOT).contains("text/event-stream");
                JSObject responseHeaders = new JSObject();
                for (Map.Entry<String, java.util.List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() != null && header.getValue() != null) responseHeaders.put(header.getKey().toLowerCase(Locale.ROOT), android.text.TextUtils.join(", ", header.getValue()));
                }
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                StringBuilder text = new StringBuilder();
                long total = 0;
                if (input != null) {
                    try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                        char[] buffer = new char[4096];
                        int length;
                        while ((length = reader.read(buffer)) != -1) {
                            if (task.cancelled) throw new Exception("请求已停止");
                            String chunk = new String(buffer, 0, length);
                            total += chunk.getBytes(StandardCharsets.UTF_8).length;
                            if (total > 4 * 1024 * 1024) throw new Exception("响应超过大小上限");
                            if (streamed) {
                                JSObject event = new JSObject(); event.put("id", id); event.put("text", chunk);
                                notifyListeners("chunk", event);
                            } else text.append(chunk);
                        }
                    }
                }
                if (task.cancelled) throw new Exception("请求已停止");
                JSObject result = new JSObject();
                result.put("status", status); result.put("headers", responseHeaders);
                result.put("streamed", streamed); result.put("text", text.toString());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(task.cancelled ? "请求已停止" : "模型连接中断：" + error.getClass().getSimpleName());
            } finally {
                if (task.connection != null) task.connection.disconnect();
                requests.remove(id, task);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id", "");
        Request request = requests.get(id);
        if (request != null) request.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Request request : requests.values()) request.cancel();
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
