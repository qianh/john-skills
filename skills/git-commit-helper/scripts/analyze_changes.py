#!/usr/bin/env python3
"""
分析 git diff 输出，生成中文变更总结
"""
import sys
import re
from typing import List, Dict, Tuple

def parse_diff_output(diff_text: str) -> Dict[str, List[str]]:
    """
    解析 git diff 输出，按文件分组变更
    """
    changes = {
        'added': [],
        'modified': [],
        'deleted': [],
        'renamed': []
    }
    
    lines = diff_text.split('\n')
    current_file = None
    
    for line in lines:
        # 新文件
        if line.startswith('new file mode'):
            if current_file:
                changes['added'].append(current_file)
        # 删除文件
        elif line.startswith('deleted file mode'):
            if current_file:
                changes['deleted'].append(current_file)
        # 重命名
        elif line.startswith('rename from'):
            old_name = line.replace('rename from ', '').strip()
            current_rename = {'from': old_name}
        elif line.startswith('rename to'):
            new_name = line.replace('rename to ', '').strip()
            if 'current_rename' in locals():
                changes['renamed'].append(f"{current_rename['from']} -> {new_name}")
        # 文件名
        elif line.startswith('diff --git'):
            match = re.search(r'b/(.+)$', line)
            if match:
                current_file = match.group(1)
                # 如果是修改的文件（不是新增或删除）
                if current_file not in changes['added'] and current_file not in changes['deleted']:
                    if current_file not in changes['modified']:
                        changes['modified'].append(current_file)
    
    return changes

def categorize_files(changes: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """
    按文件类型分类
    """
    categories = {
        '源代码': [],
        '配置文件': [],
        '文档': [],
        '测试文件': [],
        '其他': []
    }
    
    all_files = (changes['added'] + changes['modified'] + 
                 changes['deleted'] + [r.split(' -> ')[1] for r in changes['renamed']])
    
    for file in all_files:
        if any(file.endswith(ext) for ext in ['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h']):
            categories['源代码'].append(file)
        elif any(file.endswith(ext) for ext in ['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env']):
            categories['配置文件'].append(file)
        elif any(file.endswith(ext) for ext in ['.md', '.txt', '.rst', '.adoc', '.html']):
            categories['文档'].append(file)
        elif 'test' in file.lower() or file.endswith('_test.py') or file.endswith('.test.js'):
            categories['测试文件'].append(file)
        else:
            categories['其他'].append(file)
    
    # 移除空分类
    return {k: v for k, v in categories.items() if v}

def generate_summary(changes: Dict[str, List[str]], diff_text: str) -> str:
    """
    生成中文变更总结
    """
    summary_parts = []
    
    # 统计变更
    total_files = len(changes['added']) + len(changes['modified']) + len(changes['deleted']) + len(changes['renamed'])
    
    if total_files == 0:
        return "没有检测到文件变更"
    
    summary_parts.append(f"本次提交共涉及 {total_files} 个文件的变更：")
    summary_parts.append("")
    
    # 新增文件
    if changes['added']:
        summary_parts.append(f"新增文件 ({len(changes['added'])} 个)：")
        for file in changes['added'][:5]:  # 最多显示5个
            summary_parts.append(f"  + {file}")
        if len(changes['added']) > 5:
            summary_parts.append(f"  + ... 以及其他 {len(changes['added']) - 5} 个文件")
        summary_parts.append("")
    
    # 修改文件
    if changes['modified']:
        summary_parts.append(f"修改文件 ({len(changes['modified'])} 个)：")
        for file in changes['modified'][:5]:
            summary_parts.append(f"  ~ {file}")
        if len(changes['modified']) > 5:
            summary_parts.append(f"  ~ ... 以及其他 {len(changes['modified']) - 5} 个文件")
        summary_parts.append("")
    
    # 删除文件
    if changes['deleted']:
        summary_parts.append(f"删除文件 ({len(changes['deleted'])} 个)：")
        for file in changes['deleted'][:5]:
            summary_parts.append(f"  - {file}")
        if len(changes['deleted']) > 5:
            summary_parts.append(f"  - ... 以及其他 {len(changes['deleted']) - 5} 个文件")
        summary_parts.append("")
    
    # 重命名文件
    if changes['renamed']:
        summary_parts.append(f"重命名文件 ({len(changes['renamed'])} 个)：")
        for rename in changes['renamed'][:5]:
            summary_parts.append(f"  → {rename}")
        if len(changes['renamed']) > 5:
            summary_parts.append(f"  → ... 以及其他 {len(changes['renamed']) - 5} 个文件")
        summary_parts.append("")
    
    # 按类型分类
    categories = categorize_files(changes)
    if len(categories) > 1:
        summary_parts.append("文件类型分布：")
        for category, files in categories.items():
            summary_parts.append(f"  • {category}: {len(files)} 个")
        summary_parts.append("")
    
    # 代码统计
    additions = diff_text.count('\n+') - diff_text.count('\n+++')
    deletions = diff_text.count('\n-') - diff_text.count('\n---')
    
    if additions > 0 or deletions > 0:
        summary_parts.append(f"代码变更统计：+{additions} 行, -{deletions} 行")
    
    return '\n'.join(summary_parts)

def main():
    if len(sys.argv) > 1:
        # 从文件读取
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            diff_text = f.read()
    else:
        # 从标准输入读取
        diff_text = sys.stdin.read()
    
    changes = parse_diff_output(diff_text)
    summary = generate_summary(changes, diff_text)
    print(summary)

if __name__ == '__main__':
    main()
