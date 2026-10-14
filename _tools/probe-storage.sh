#!/system/bin/sh
# 在设备内以应用身份读 localStorage 的落盘内容（debuggable 包才能 run-as）
B="/data/data/com.noadic.app/app_webview/Default/Local Storage/leveldb"
echo "== ls =="
ls -l "$B" 2>&1
echo "== total size (KB) =="
du -sk "$B" 2>&1
echo "== keys seen =="
cat "$B"/*.log "$B"/*.ldb 2>/dev/null | grep -a -o -E '(noadic|cet4)[._a-z]*' | sort -u
echo "== does the undo slot exist? =="
cat "$B"/*.log 2>/dev/null | grep -a -c 'noadic.undo'
echo "== main state key count =="
cat "$B"/*.log 2>/dev/null | grep -a -c 'noadic.v1'
